/**
 * Tango Market Research — a Google Apps Script that turns the container
 * spreadsheet into a federal market-research worksheet.
 *
 * Describe a requirement on the "Research" tab, run Tango ▸ Run market
 * research, and get three output tabs:
 *
 *   Similar Requirements — open + recently closed SAM.gov opportunities
 *   Award Evidence       — recent awards for similar work (FPDS)
 *   Vendors              — awards rolled up per vendor, ranked by dollars,
 *                          with set-aside history and SAM registration data
 *
 * Auth: Tango ▸ Set API key… (stored in *user* properties, per Google
 * account — never written into the spreadsheet). Get a key at
 * https://tango.makegov.com — API docs at https://docs.makegov.com/
 */

const TANGO_BASE = "https://tango.makegov.com";

// Field shapes (the API's ?shape= parameter) keep responses small, so
// UrlFetchApp stays fast even on broad searches.
const OPP_SHAPE = "opportunity_id,title,solicitation_number,active," +
  "response_deadline,first_notice_date,last_notice_date,set_aside," +
  "naics_code,psc_code,sam_url,agency(name,code),office(office_name,office_code)";
const AWARD_SHAPE = "key,piid,solicitation_identifier,award_date,description," +
  "obligated,total_contract_value,set_aside(*),recipient(uei,display_name)," +
  "awarding_office(*),naics(*),psc(*)";
const ENTITY_SHAPE = "uei,display_name,registration_status," +
  "business_types(code,description)";

// Result caps. Raise them if you need more depth — the fetcher follows the
// API's cursor pagination until it hits the cap.
const MAX_REQUIREMENTS = 50;   // per pass (open, closed)
const MAX_AWARDS = 150;
const ENRICH_TOP_VENDORS = 15; // vendors to look up in SAM entity data

const SHEETS = {
  research: "Research",
  requirements: "Similar Requirements",
  awards: "Award Evidence",
  vendors: "Vendors",
};

// ---------------------------------------------------------------- menu --

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Tango")
    .addItem("Run market research", "runMarketResearch")
    .addItem("Set API key…", "setApiKey")
    .addSeparator()
    .addItem("Reset research inputs", "resetInputs")
    .addToUi();
}

function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    "Tango API key",
    "Paste your key from tango.makegov.com.\n\nStored in your user " +
      "properties — tied to your Google account, never written into the " +
      "spreadsheet.",
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const key = resp.getResponseText().trim();
  if (!key) return;
  PropertiesService.getUserProperties().setProperty("TANGO_API_KEY", key);
  ui.alert("Saved. Run Tango ▸ Run market research.");
}

/** Builds (or rebuilds) the Research input tab. */
function resetInputs() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEETS.research) || ss.insertSheet(SHEETS.research, 0);
  sheet.clear();
  const rows = [
    ["Tango Market Research", "", ""],
    ["", "", ""],
    ["Requirement description", "", "Plain English — e.g. \"enterprise IT service desk\". Describe the work; the search is semantic, not keyword-exact."],
    ["NAICS code(s)", "", "Optional. 541512, or 541511|541512 for OR."],
    ["PSC code(s)", "", "Optional. DE01, or DA01|DE01 for OR."],
    ["Agency", "", "Optional. Name, abbreviation, or code — fuzzy matched (\"VA\", \"Air Force\")."],
    ["Lookback (years)", 5, "How far back to pull closed requirements and award evidence."],
  ];
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange("A1").setFontSize(14).setFontWeight("bold");
  sheet.getRange("A3:A7").setFontWeight("bold");
  sheet.getRange("B3:B7").setBackground("#fef7e0").setBorder(true, true, true, true, false, false);
  sheet.getRange("C3:C7").setFontColor("#5f6368").setFontStyle("italic").setWrap(true);
  sheet.setColumnWidth(1, 220).setColumnWidth(2, 320).setColumnWidth(3, 460);
  sheet.getRange("B3").activate();
}

// ----------------------------------------------------------------- run --

function runMarketResearch() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  if (!getKey_()) {
    ui.alert("No API key yet — run Tango ▸ Set API key… first. Get one at tango.makegov.com.");
    return;
  }
  if (!ss.getSheetByName(SHEETS.research)) resetInputs();
  const q = readInputs_();
  if (!q.search && !q.naics && !q.psc) {
    ui.alert("Describe the requirement (B3), or give a NAICS (B4) or PSC (B5) code, on the \"" + SHEETS.research + "\" tab.");
    return;
  }

  const common = {search: q.search, naics: q.naics, psc: q.psc, agency: q.agency};

  ss.toast("Pulling similar requirements…", "Tango", -1);
  const open = tangoList_("/api/opportunities/", Object.assign({}, common, {
    active: "true", ordering: "-first_notice_date", shape: OPP_SHAPE,
  }), MAX_REQUIREMENTS);
  let closed = tangoList_("/api/opportunities/", Object.assign({}, common, {
    active: "false", first_notice_date_after: q.since,
    ordering: "-first_notice_date", shape: OPP_SHAPE,
  }), MAX_REQUIREMENTS);
  if (!closed.length && q.search && (q.naics || q.psc)) {
    // Description search over closed notices can come up dry where the code
    // filters wouldn't — retry the closed pass on structure alone.
    closed = tangoList_("/api/opportunities/", {
      naics: q.naics, psc: q.psc, agency: q.agency, active: "false",
      first_notice_date_after: q.since, ordering: "-first_notice_date", shape: OPP_SHAPE,
    }, MAX_REQUIREMENTS);
  }

  ss.toast("Pulling award evidence…", "Tango", -1);
  const awards = tangoList_("/api/contracts/", {
    search: q.search, naics: q.naics, psc: q.psc, awarding_agency: q.agency,
    award_date_gte: q.since, shape: AWARD_SHAPE,
  }, MAX_AWARDS);

  ss.toast("Rolling up vendors…", "Tango", -1);
  const vendors = rollupVendors_(awards);
  enrichVendors_(vendors.slice(0, ENRICH_TOP_VENDORS));

  writeRequirements_(open, closed);
  writeAwards_(awards);
  writeVendors_(vendors);
  writeSummary_(q, open, closed, awards, vendors);
  ss.setActiveSheet(ss.getSheetByName(SHEETS.vendors));
  ss.toast("Done — " + vendors.length + " vendors from " + awards.length + " awards.", "Tango", 8);
}

function readInputs_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.research);
  const val = (a1) => String(sheet.getRange(a1).getValue() || "").trim();
  const years = Number(val("B7")) || 5;
  const since = new Date();
  since.setFullYear(since.getFullYear() - years);
  return {
    search: val("B3"),
    naics: val("B4"),
    psc: val("B5"),
    agency: val("B6"),
    years: years,
    since: Utilities.formatDate(since, "UTC", "yyyy-MM-dd"),
  };
}

// ---------------------------------------------------------------- tango --

function getKey_() {
  return PropertiesService.getUserProperties().getProperty("TANGO_API_KEY");
}

function tangoFetch_(url) {
  const resp = UrlFetchApp.fetch(url, {
    headers: {"X-API-KEY": getKey_()},
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 401 || code === 403) {
    throw new Error("Tango rejected the API key — run Tango ▸ Set API key…");
  }
  if (code >= 400) {
    throw new Error("Tango returned HTTP " + code + ": " + String(resp.getContentText()).slice(0, 300));
  }
  return JSON.parse(resp.getContentText());
}

/** GETs a list endpoint and follows cursor pagination until `cap` records. */
function tangoList_(path, params, cap) {
  let url = TANGO_BASE + path + "?" + buildQuery_(params);
  const out = [];
  while (url && out.length < cap) {
    const body = tangoFetch_(url);
    const page = body.results || [];
    for (let i = 0; i < page.length && out.length < cap; i++) out.push(page[i]);
    url = body.next || null;
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

// --------------------------------------------------------------- rollup --

function rollupVendors_(awards) {
  const byVendor = {};
  for (const a of awards) {
    const uei = (a.recipient && a.recipient.uei) || "";
    const name = (a.recipient && a.recipient.display_name) || "(unknown vendor)";
    const k = uei || name;
    const v = byVendor[k] || (byVendor[k] = {
      name: name, uei: uei, awards: 0, obligated: 0, lastAward: "",
      agencies: {}, naics: {}, setAsides: {}, registration: "", businessTypes: "",
    });
    v.awards += 1;
    v.obligated += Number(a.obligated) || 0;
    if ((a.award_date || "") > v.lastAward) v.lastAward = a.award_date || "";
    const office = a.awarding_office || {};
    const agency = office.department_name || office.agency_name || "";
    if (agency) v.agencies[agency] = true;
    if (a.naics && a.naics.code) v.naics[a.naics.code] = true;
    const sa = a.set_aside && (a.set_aside.code || a.set_aside.description);
    if (sa) v.setAsides[sa] = true;
  }
  return Object.keys(byVendor).map((k) => byVendor[k])
    .sort((x, y) => y.obligated - x.obligated);
}

/** Adds SAM registration status + business types to the top vendors. */
function enrichVendors_(vendors) {
  for (const v of vendors) {
    if (!v.uei) continue;
    try {
      const e = tangoFetch_(TANGO_BASE + "/api/entities/" + encodeURIComponent(v.uei) +
        "/?shape=" + encodeURIComponent(ENTITY_SHAPE));
      v.registration = e.registration_status || "";
      v.businessTypes = (e.business_types || [])
        .map((b) => b.description || b.code).filter(Boolean).slice(0, 6).join("; ");
    } catch (err) {
      // Entity lookups are gravy — a vendor that errors here keeps its rollup.
    }
  }
}

// ---------------------------------------------------------------- write --

function writeRequirements_(open, closed) {
  const headers = ["Status", "Title", "Solicitation #", "Agency", "Office",
    "Set-aside", "NAICS", "PSC", "Posted", "Deadline", "SAM.gov"];
  const rows = open.map((o) => oppRow_(o, "Open"))
    .concat(closed.map((o) => oppRow_(o, "Closed")));
  writeTable_(SHEETS.requirements, headers, rows, {});
}

function oppRow_(o, status) {
  return [
    status,
    o.title || "",
    o.solicitation_number || "",
    (o.agency && o.agency.name) || "",
    (o.office && o.office.office_name) || "",
    o.set_aside || "",
    o.naics_code || "",
    o.psc_code || "",
    dateOnly_(o.first_notice_date),
    dateOnly_(o.response_deadline),
    o.sam_url || "",
  ];
}

function writeAwards_(awards) {
  const headers = ["Awarded", "Vendor", "UEI", "PIID", "Solicitation #",
    "Agency", "Office", "NAICS", "PSC", "Set-aside", "Obligated",
    "Total value", "Description", "USASpending"];
  const rows = awards.map((a) => {
    const office = a.awarding_office || {};
    return [
      a.award_date || "",
      (a.recipient && a.recipient.display_name) || "",
      (a.recipient && a.recipient.uei) || "",
      a.piid || "",
      a.solicitation_identifier || "",
      office.department_name || office.agency_name || "",
      office.office_name || "",
      (a.naics && a.naics.code) || "",
      (a.psc && a.psc.code) || "",
      (a.set_aside && (a.set_aside.code || a.set_aside.description)) || "",
      Number(a.obligated) || 0,
      Number(a.total_contract_value) || 0,
      cleanText_(a.description),
      a.key ? "https://www.usaspending.gov/award/" + encodeURIComponent(a.key) : "",
    ];
  });
  writeTable_(SHEETS.awards, headers, rows, {11: "$#,##0", 12: "$#,##0"});
}

function writeVendors_(vendors) {
  const headers = ["Vendor", "UEI", "Awards", "Total obligated", "Last award",
    "Agencies", "NAICS", "Set-asides won", "SAM registration", "Business types"];
  const rows = vendors.map((v) => [
    v.name,
    v.uei,
    v.awards,
    v.obligated,
    v.lastAward,
    Object.keys(v.agencies).join("; "),
    Object.keys(v.naics).join(", "),
    Object.keys(v.setAsides).join(", "),
    v.registration,
    v.businessTypes,
  ]);
  writeTable_(SHEETS.vendors, headers, rows, {4: "$#,##0"});
}

function writeSummary_(q, open, closed, awards, vendors) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.research);
  const totalObligated = awards.reduce((s, a) => s + (Number(a.obligated) || 0), 0);
  const setAsideVendors = vendors.filter((v) => Object.keys(v.setAsides).length).length;
  const rows = [
    ["Last run", new Date(), ""],
    ["Open requirements", open.length, "active opportunities matching the search"],
    ["Closed requirements", closed.length, "since " + q.since],
    ["Awards analyzed", awards.length, "$" + Math.round(totalObligated).toLocaleString() + " obligated since " + q.since],
    ["Distinct vendors", vendors.length, ""],
    ["Vendors with set-aside wins", setAsideVendors, "two or more capable small businesses supports a set-aside (the \"rule of two\") — verify current size status in SAM/DSBS"],
  ];
  sheet.getRange(9, 1, rows.length, 3).setValues(rows);
  sheet.getRange(9, 1, rows.length, 1).setFontWeight("bold");
  sheet.getRange(9, 3, rows.length, 1).setFontColor("#5f6368").setFontStyle("italic").setWrap(true);
}

function writeTable_(name, headers, rows, formats) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight("bold").setBackground("#f1f3f4");
  sheet.setFrozenRows(1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    for (const col in formats) {
      sheet.getRange(2, Number(col), rows.length, 1).setNumberFormat(formats[col]);
    }
  } else {
    sheet.getRange(2, 1)
      .setValue("No results — broaden the description or drop a filter.")
      .setFontStyle("italic");
  }
  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

// --------------------------------------------------------------- format --

function dateOnly_(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

/** FPDS descriptions carry control delimiters like "|!#^" — strip them. */
function cleanText_(text) {
  if (!text) return "";
  const cleaned = String(text).replace(/\|!#\^/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 240 ? cleaned.slice(0, 237) + "…" : cleaned;
}

/**
 * Tango Market Research Memo — pull the docs themselves, then draft the memo.
 *
 * Describe a requirement on the "Research" tab, run
 * Tango ▸ Pull docs + draft memo, and the script:
 *
 *   1. Finds similar requirements (SAM.gov opportunities, open and closed).
 *   2. Downloads their actual solicitation documents — SOWs, PWSs, RFP
 *      packages — into a Drive folder, one subfolder per requirement.
 *   3. Looks up who won each one (FPDS awards by solicitation number).
 *   4. Drafts a Google Doc: a FAR Part 10-style market research memo that
 *      quotes each notice, links every document set, and tables the
 *      vendor field — with the evidence folder as its exhibits.
 *
 * A "Doc Index" tab tracks everything pulled.
 *
 * Auth: Tango ▸ Set API key… (stored in *user* properties, per Google
 * account — never written into the spreadsheet). Document downloads hit
 * SAM.gov's public attachment URLs directly, no key needed.
 *
 * Get a key at https://tango.makegov.com — API docs at https://docs.makegov.com/
 */

const TANGO_BASE = "https://tango.makegov.com";

const OPP_LIST_SHAPE = "opportunity_id,title,solicitation_number,active," +
  "response_deadline,first_notice_date,set_aside,naics_code,psc_code,sam_url," +
  "agency(name,code),office(office_name,office_code)";
const WINNER_SHAPE = "key,piid,award_date,obligated,recipient(uei,display_name)";

const MAX_REQUIREMENTS = 40;   // similar requirements scanned per pass (open, closed)
const MAX_FILES_PER_REQ = 10;  // file attachments downloaded per requirement
const MAX_FILE_MB = 30;        // skip larger files (UrlFetchApp's hard limit is 50MB)
const MAX_WINNERS_PER_REQ = 5; // awards matched per solicitation (MATOCs have several)
const MAX_WINNER_LOOKUPS = 25; // closed requirements beyond the doc pulls to award-match
const MAX_EVIDENCE_AWARDS = 150; // broader market awards pulled for the vendor rollup
const MEMO_VENDOR_ROWS = 15;   // vendors tabled in the memo (full list on the Vendors tab)
const EXCERPT_CHARS = 450;     // notice text quoted per requirement in the memo

const EVIDENCE_SHAPE = "key,piid,award_date,obligated,set_aside(*)," +
  "recipient(uei,display_name),awarding_office(*),naics(*)";

const SHEETS = {research: "Research", index: "Doc Index", vendors: "Vendors"};

// ---------------------------------------------------------------- menu --

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Tango")
    .addItem("Pull docs + draft memo", "runMarketResearch")
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
  ui.alert("Saved. Run Tango ▸ Pull docs + draft memo.");
}

/** Builds (or rebuilds) the Research input tab. */
function resetInputs() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEETS.research) || ss.insertSheet(SHEETS.research, 0);
  sheet.clear();
  const rows = [
    ["Tango Market Research — docs + memo", "", ""],
    ["", "", ""],
    ["Requirement description", "", "Plain English — e.g. \"base custodial services\". Describe the work; the search is semantic."],
    ["NAICS code(s)", "", "Optional. 561720, or 561720|561210 for OR."],
    ["PSC code(s)", "", "Optional. S201, or S201|S214 for OR."],
    ["Agency", "", "Optional. Name, abbreviation, or code — fuzzy matched (\"Navy\", \"GSA\")."],
    ["Lookback (years)", 3, "How far back to scan closed requirements."],
    ["Requirements to pull docs for", 8, "The N most recent get their documents downloaded. More = slower run."],
  ];
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange("A1").setFontSize(14).setFontWeight("bold");
  sheet.getRange("A3:A8").setFontWeight("bold");
  sheet.getRange("B3:B8").setBackground("#fef7e0").setBorder(true, true, true, true, false, false);
  sheet.getRange("C3:C8").setFontColor("#5f6368").setFontStyle("italic").setWrap(true);
  sheet.setColumnWidth(1, 240).setColumnWidth(2, 320).setColumnWidth(3, 460);
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

  ss.toast("Finding similar requirements…", "Tango", -1);
  const found = findRequirements_(q);
  if (!found.length) {
    ui.alert("No similar requirements found — broaden the description or drop a filter.");
    return;
  }

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  const folder = DriveApp.createFolder("Market research — " + memoLabel_(q) + " — " + stamp);

  const targets = found.slice(0, q.docPulls);
  const entries = [];
  for (let i = 0; i < targets.length; i++) {
    ss.toast("Pulling docs " + (i + 1) + "/" + targets.length + ": " + (targets[i].title || "").slice(0, 60), "Tango", -1);
    entries.push(pullRequirement_(targets[i], folder));
  }

  ss.toast("Matching awards to requirements…", "Tango", -1);
  const others = matchOtherWinners_(found.slice(q.docPulls));

  ss.toast("Pulling broader award evidence…", "Tango", -1);
  const evidence = tangoList_("/api/contracts/", {
    search: q.search, naics: q.naics, psc: q.psc, awarding_agency: q.agency,
    award_date_gte: q.since, shape: EVIDENCE_SHAPE,
  }, MAX_EVIDENCE_AWARDS);
  const vendors = rollupVendors_(evidence);

  ss.toast("Drafting the memo…", "Tango", -1);
  const memoUrl = buildMemo_(q, entries, others, found, folder, vendors, evidence.length);

  writeIndex_(entries, others);
  writeVendors_(vendors);
  writeSummary_(q, found, entries, vendors, folder.getUrl(), memoUrl);
  ss.setActiveSheet(ss.getSheetByName(SHEETS.index));
  const files = entries.reduce((s, e) => s + e.files.length, 0);
  ss.toast("Done — " + files + " documents, " + vendors.length + " vendors. Memo drafted.", "Tango", 10);
}

function readInputs_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.research);
  const val = (a1) => String(sheet.getRange(a1).getValue() || "").trim();
  const years = Number(val("B7")) || 3;
  const since = new Date();
  since.setFullYear(since.getFullYear() - years);
  return {
    search: val("B3"),
    naics: val("B4"),
    psc: val("B5"),
    agency: val("B6"),
    years: years,
    since: Utilities.formatDate(since, "UTC", "yyyy-MM-dd"),
    docPulls: Math.max(1, Number(val("B8")) || 8),
  };
}

/** Open + closed similar requirements, most recent first. */
function findRequirements_(q) {
  const common = {search: q.search, naics: q.naics, psc: q.psc, agency: q.agency,
    ordering: "-first_notice_date", shape: OPP_LIST_SHAPE};
  const open = tangoList_("/api/opportunities/", Object.assign({}, common, {active: "true"}), MAX_REQUIREMENTS);
  let closed = tangoList_("/api/opportunities/", Object.assign({}, common, {
    active: "false", first_notice_date_after: q.since,
  }), MAX_REQUIREMENTS);
  if (!closed.length && q.search && (q.naics || q.psc)) {
    // Text search over closed notices can come up dry where codes won't —
    // retry the closed pass on structure alone.
    closed = tangoList_("/api/opportunities/", Object.assign({}, common, {
      active: "false", first_notice_date_after: q.since, search: null,
    }), MAX_REQUIREMENTS);
  }
  return open.concat(closed).sort((a, b) =>
    String(b.first_notice_date || "").localeCompare(String(a.first_notice_date || "")));
}

// ------------------------------------------------------- pull one req --

/**
 * Fetches one requirement's detail, downloads its file attachments into a
 * Drive subfolder, and looks up the winning award(s). Never throws for a
 * single bad document — failures are recorded and the run continues.
 */
function pullRequirement_(opp, rootFolder) {
  const entry = {
    opp: opp,
    excerpt: "",
    noticeType: "",  // SAM notice type code — "a" is an award notice
    files: [],       // {name, url (Drive)}
    failed: [],      // {name, reason}
    links: [],       // type:"link" attachments — indexed, not downloaded
    folderUrl: "",
    winners: [],     // {vendor, uei, piid, key, awardDate, obligated}
  };

  let detail = null;
  try {
    detail = tangoFetch_(TANGO_BASE + "/api/opportunities/" + encodeURIComponent(opp.opportunity_id) + "/");
  } catch (err) {
    entry.failed.push({name: "(detail fetch)", reason: err.message});
  }

  if (detail) {
    entry.excerpt = excerpt_(detail.description);
    entry.noticeType = (detail.meta && detail.meta.notice_type && detail.meta.notice_type.code) || "";
    const attachments = detail.attachments || [];
    entry.links = attachments.filter((a) => a.type === "link" && a.url).map((a) => a.url);

    // Amendments repost attachments, so the manifest often lists the same
    // filename under several notice versions — group by name and keep the
    // first copy that actually downloads.
    const byName = {};
    const order = [];
    for (const a of attachments) {
      if (a.type !== "file" || !a.url) continue;
      const k = String(a.name || a.resource_id || a.url).toLowerCase();
      if (!byName[k]) { byName[k] = []; order.push(k); }
      byName[k].push(a);
    }

    if (order.length) {
      const sub = rootFolder.createFolder(safeName_(
        (opp.solicitation_number || opp.opportunity_id) + " — " + (opp.title || "")));
      entry.folderUrl = sub.getUrl();
      for (const k of order.slice(0, MAX_FILES_PER_REQ)) {
        const candidates = byName[k];
        const name = candidates[0].name || ("attachment" + extFor_(candidates[0].mime_type));
        let saved = false;
        let lastReason = "no downloadable copy";
        for (const att of candidates) {
          if (att.file_size && att.file_size > MAX_FILE_MB * 1024 * 1024) {
            lastReason = "skipped, over " + MAX_FILE_MB + "MB";
            continue;
          }
          try {
            // SAM.gov public attachment URL — no Tango key on this request.
            const resp = UrlFetchApp.fetch(att.url, {muteHttpExceptions: true});
            if (resp.getResponseCode() !== 200) {
              lastReason = "HTTP " + resp.getResponseCode();
              continue;
            }
            const file = sub.createFile(resp.getBlob().setName(safeName_(name)));
            entry.files.push({name: name, url: file.getUrl()});
            saved = true;
            break;
          } catch (err) {
            lastReason = String(err.message || err).slice(0, 120);
          }
        }
        if (!saved) entry.failed.push({name: name, reason: lastReason});
      }
    }
  }

  entry.winners = findWinners_(opp.solicitation_number);
  return entry;
}

/**
 * FPDS awards for a solicitation number. Retries with punctuation stripped
 * (FPDS drops it, SAM keeps it — same trick as the lookup extension), then
 * falls back to PIID matching: award notices put the award number, not the
 * solicitation number, in SAM's solicitation field.
 */
function findWinners_(solicitationNumber) {
  const sol = String(solicitationNumber || "").trim();
  const stripped = sol.replace(/[^A-Za-z0-9]/g, "");
  if (stripped.length < 6) return []; // junk ids ("1992", "12c2") match noise, not lineage
  let awards = winnerQuery_({solicitation_identifier: sol});
  if (!awards.length && stripped !== sol) awards = winnerQuery_({solicitation_identifier: stripped});
  if (!awards.length) awards = winnerQuery_({piid: sol});
  if (!awards.length && stripped !== sol) awards = winnerQuery_({piid: stripped});
  return awards.map((a) => ({
    vendor: (a.recipient && a.recipient.display_name) || "(unknown vendor)",
    uei: (a.recipient && a.recipient.uei) || "",
    piid: a.piid || "",
    key: a.key || "",
    awardDate: a.award_date || "",
    obligated: Number(a.obligated) || 0,
  }));
}

function winnerQuery_(filters) {
  try {
    return tangoList_("/api/contracts/",
      Object.assign({shape: WINNER_SHAPE}, filters), MAX_WINNERS_PER_REQ);
  } catch (err) {
    return [];
  }
}

/** Flattens matched requirements' winners, deduped by award — the same
 *  award surfaces under presol + sol notice records sharing a number. */
function dedupeDirectWins_(matched) {
  const out = [];
  const seen = {};
  for (const e of matched) {
    for (const w of e.winners) {
      const k = w.key || (w.vendor + "|" + w.piid + "|" + w.awardDate);
      if (seen[k]) continue;
      seen[k] = true;
      out.push({w: w, sol: e.opp.solicitation_number || ""});
    }
  }
  return out;
}

function countUniqueVendors_(wins) {
  const seen = {};
  for (const d of wins) seen[d.w.uei || d.w.vendor] = true;
  return Object.keys(seen).length;
}

/** Award-matches the scanned requirements beyond the doc pulls. Open notices
 *  can't have awards yet, so only closed ones spend lookups (capped). */
function matchOtherWinners_(opps) {
  const out = [];
  let looked = 0;
  for (const o of opps) {
    let winners = [];
    if (!o.active && looked < MAX_WINNER_LOOKUPS) {
      winners = findWinners_(o.solicitation_number);
      looked += 1;
    }
    out.push({opp: o, winners: winners});
  }
  return out;
}

/** Broader market evidence, grouped per vendor and ranked by dollars. */
function rollupVendors_(awards) {
  const byVendor = {};
  for (const a of awards) {
    const uei = (a.recipient && a.recipient.uei) || "";
    const name = (a.recipient && a.recipient.display_name) || "(unknown vendor)";
    const k = uei || name;
    const v = byVendor[k] || (byVendor[k] = {
      name: name, uei: uei, awards: 0, obligated: 0, lastAward: "",
      agencies: {}, naics: {}, setAsides: {},
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

// ----------------------------------------------------------------- memo --

/** Drafts the memo Doc inside the evidence folder; returns its URL. */
function buildMemo_(q, entries, others, found, folder, vendors, evidenceCount) {
  const doc = DocumentApp.create("Market Research Memo — " + memoLabel_(q));
  const body = doc.getBody();
  const H = DocumentApp.ParagraphHeading;

  body.appendParagraph("Market Research Memorandum").setHeading(H.TITLE);
  body.appendParagraph("Subject: " + memoLabel_(q)).setHeading(H.SUBTITLE);
  body.appendParagraph("Date: " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy"));
  body.appendParagraph("Prepared by: ______________________");
  body.appendParagraph("Sources: SAM.gov notices and attachments, FPDS award data — via the Tango API (tango.makegov.com). Exhibits in the linked Drive folder.")
    .setItalic(true);

  body.appendParagraph("1. Purpose and scope").setHeading(H.HEADING1);
  body.appendParagraph(
    "This memorandum documents market research conducted for the requirement described as: \"" +
    (q.search || "(defined by code filters)") + "\"" + filterSentence_(q) +
    ". It surveys how similar requirements have been solicited, the documents that defined them, " +
    "and the vendors that won the resulting awards.");

  body.appendParagraph("2. Summary of findings").setHeading(H.HEADING1);
  const openCount = found.filter((o) => o.active).length;
  const fileCount = entries.reduce((s, e) => s + e.files.length, 0);
  const matched = entries.concat(others);
  const directWins = dedupeDirectWins_(matched);
  const setAsideCounts = countBy_(found, (o) => o.set_aside || "None / unspecified");
  const bullets = [
    found.length + " similar requirements identified (" + openCount + " currently open); of the most recent " +
      entries.length + ", " + fileCount + " solicitation documents were retrieved as exhibits.",
    directWins.length + " award(s) were matched to these requirements by solicitation or award number, naming " +
      countUniqueVendors_(directWins) + " distinct vendor(s) — see Section 4.",
    "Broader market: " + vendors.length + " vendor(s) won " + evidenceCount +
      " awards matching this market since " + q.since + ".",
    "Set-aside pattern across all " + found.length + " notices: " + setAsideSentence_(setAsideCounts) + ".",
  ];
  for (const b of bullets) body.appendListItem(b).setGlyphType(DocumentApp.GlyphType.BULLET);
  body.appendParagraph(
    "Note: set-aside history reflects how prior requirements were competed, not the current size status " +
    "of any vendor. Verify size and socioeconomic status in SAM/DSBS before relying on the \"rule of two.\"")
    .setItalic(true);

  body.appendParagraph("3. Requirement history").setHeading(H.HEADING1);
  for (const e of entries) {
    const o = e.opp;
    body.appendParagraph((o.solicitation_number || "No solicitation #") + " — " + (o.title || "Untitled"))
      .setHeading(H.HEADING2);
    body.appendParagraph(metaLine_(o));
    if (e.excerpt) {
      body.appendParagraph("“" + e.excerpt + "”").setItalic(true).setIndentStart(36);
    }
    if (e.files.length) {
      appendLink_(body, "Documents: " + e.files.length + " file(s) — open the exhibit folder", e.folderUrl);
      for (const f of e.files) appendLink_(body, "    • " + f.name, f.url);
    } else {
      appendLink_(body, "Documents: none retrieved — see the notice on SAM.gov", o.sam_url || "");
    }
    for (const bad of e.failed) {
      body.appendParagraph("    • " + bad.name + " — not retrieved (" + bad.reason + ")").setItalic(true);
    }
    for (const link of e.links) appendLink_(body, "    ↗ Referenced link: " + link, link);
    if (e.winners.length) {
      for (const w of e.winners) {
        appendLink_(body,
          "Outcome: awarded to " + w.vendor + (w.awardDate ? " on " + w.awardDate : "") +
          " — " + money_(w.obligated) + " obligated (" + w.piid + ")",
          w.key ? "https://www.usaspending.gov/award/" + encodeURIComponent(w.key) : "");
      }
    } else if (e.noticeType === "a") {
      body.appendParagraph("Outcome: award notice — the award is announced in the notice text above; " +
        "no FPDS record matched yet (reporting can lag an award by up to 90 days).");
    } else {
      body.appendParagraph("Outcome: no award located by solicitation or award number" +
        (o.active ? " (still open)" : "") + ".");
    }
  }

  body.appendParagraph("4. Vendor field").setHeading(H.HEADING1);

  body.appendParagraph("Direct outcomes — awards matched to the requirements above").setHeading(H.HEADING2);
  if (directWins.length) {
    const winnerRows = [["Vendor", "UEI", "Solicitation #", "Award date", "Obligated"]];
    for (const d of directWins) {
      winnerRows.push([d.w.vendor, d.w.uei, d.sol, d.w.awardDate, money_(d.w.obligated)]);
    }
    boldHeaderTable_(body, winnerRows);
  } else {
    body.appendParagraph("No awards matched by solicitation or award number. Recently closed solicitations " +
      "are often unawarded or not yet reported — FPDS can lag an award by up to 90 days. The broader " +
      "evidence below covers the gap.");
  }

  body.appendParagraph("The broader vendor field — who wins this kind of work").setHeading(H.HEADING2);
  if (vendors.length) {
    body.appendParagraph("Across " + evidenceCount + " awards matching this market definition since " + q.since +
      " (top " + Math.min(vendors.length, MEMO_VENDOR_ROWS) + " of " + vendors.length +
      " vendors by obligated dollars — full list on the Vendors tab):");
    const vendorRows = [["Vendor", "Awards", "Obligated", "Agencies", "Set-asides won"]];
    for (const v of vendors.slice(0, MEMO_VENDOR_ROWS)) {
      vendorRows.push([v.name, String(v.awards), money_(v.obligated),
        Object.keys(v.agencies).join("; "), Object.keys(v.setAsides).join(", ") || "—"]);
    }
    boldHeaderTable_(body, vendorRows);
  } else {
    body.appendParagraph("No awards matched the market definition over the lookback — broaden the " +
      "description or drop a filter.");
  }

  body.appendParagraph("5. Exhibits").setHeading(H.HEADING1);
  appendLink_(body, "Evidence folder (all retrieved solicitation documents): " + folder.getName(), folder.getUrl());

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return doc.getUrl();
}

// ---------------------------------------------------------------- sheet --

function writeIndex_(entries, others) {
  const headers = ["Status", "Title", "Solicitation #", "Agency", "Office", "Posted",
    "Deadline", "Set-aside", "Docs", "Folder", "Winner(s)", "Obligated", "SAM.gov"];
  const rows = [];
  for (const e of entries) {
    const o = e.opp;
    rows.push([
      o.active ? "Open" : "Closed",
      o.title || "",
      o.solicitation_number || "",
      (o.agency && o.agency.name) || "",
      (o.office && o.office.office_name) || "",
      dateOnly_(o.first_notice_date),
      dateOnly_(o.response_deadline),
      o.set_aside || "",
      e.files.length + (e.failed.length ? " (+" + e.failed.length + " failed)" : ""),
      e.folderUrl,
      e.winners.map((w) => w.vendor).join("; "),
      e.winners.reduce((s, w) => s + w.obligated, 0),
      o.sam_url || "",
    ]);
  }
  for (const m of others) {
    const o = m.opp;
    rows.push([o.active ? "Open" : "Closed", o.title || "", o.solicitation_number || "",
      (o.agency && o.agency.name) || "", (o.office && o.office.office_name) || "",
      dateOnly_(o.first_notice_date), dateOnly_(o.response_deadline), o.set_aside || "",
      "not pulled", "",
      m.winners.map((w) => w.vendor).join("; "),
      m.winners.length ? m.winners.reduce((s, w) => s + w.obligated, 0) : "",
      o.sam_url || ""]);
  }
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEETS.index) || ss.insertSheet(SHEETS.index);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight("bold").setBackground("#f1f3f4");
  sheet.setFrozenRows(1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 12, rows.length, 1).setNumberFormat("$#,##0");
  }
  sheet.autoResizeColumns(1, headers.length);
}

function writeVendors_(vendors) {
  const headers = ["Vendor", "UEI", "Awards", "Total obligated", "Last award",
    "Agencies", "NAICS", "Set-asides won"];
  const rows = vendors.map((v) => [
    v.name, v.uei, v.awards, v.obligated, v.lastAward,
    Object.keys(v.agencies).join("; "),
    Object.keys(v.naics).join(", "),
    Object.keys(v.setAsides).join(", "),
  ]);
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEETS.vendors) || ss.insertSheet(SHEETS.vendors);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight("bold").setBackground("#f1f3f4");
  sheet.setFrozenRows(1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 4, rows.length, 1).setNumberFormat("$#,##0");
  }
  sheet.autoResizeColumns(1, headers.length);
}

function writeSummary_(q, found, entries, vendors, folderUrl, memoUrl) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.research);
  const fileCount = entries.reduce((s, e) => s + e.files.length, 0);
  const rows = [
    ["Last run", new Date(), ""],
    ["Similar requirements", found.length, found.filter((o) => o.active).length + " open"],
    ["Docs pulled", fileCount, "across " + entries.length + " requirements (see Doc Index)"],
    ["Vendors identified", vendors.length, "ranked by dollars on the Vendors tab"],
    ["Evidence folder", folderUrl, ""],
    ["Draft memo", memoUrl, "review, edit, and sign — it's a draft, not a determination"],
  ];
  sheet.getRange(10, 1, rows.length, 3).setValues(rows);
  sheet.getRange(10, 1, rows.length, 1).setFontWeight("bold");
  sheet.getRange(10, 3, rows.length, 1).setFontColor("#5f6368").setFontStyle("italic").setWrap(true);
}

// -------------------------------------------------------------- helpers --

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

function boldHeaderTable_(body, rows) {
  const table = body.appendTable(rows);
  for (let c = 0; c < rows[0].length; c++) {
    table.getRow(0).getCell(c).editAsText().setBold(true);
  }
  return table;
}

function appendLink_(body, label, url) {
  const p = body.appendParagraph(label);
  if (url) p.editAsText().setLinkUrl(0, label.length - 1, url);
  return p;
}

function metaLine_(o) {
  const parts = [
    (o.agency && o.agency.name) || "",
    (o.office && o.office.office_name) || "",
    o.active ? "Open" : "Closed",
    o.first_notice_date ? "posted " + dateOnly_(o.first_notice_date) : "",
    o.response_deadline ? "responses due " + dateOnly_(o.response_deadline) : "",
    o.set_aside ? "set-aside: " + o.set_aside : "",
    o.naics_code ? "NAICS " + o.naics_code : "",
    o.psc_code ? "PSC " + o.psc_code : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function memoLabel_(q) {
  return q.search || [q.naics && "NAICS " + q.naics, q.psc && "PSC " + q.psc]
    .filter(Boolean).join(", ") || "market research";
}

function filterSentence_(q) {
  const f = [];
  if (q.naics) f.push("NAICS " + q.naics);
  if (q.psc) f.push("PSC " + q.psc);
  if (q.agency) f.push("agency: " + q.agency);
  const scope = " over a " + q.years + "-year lookback";
  return (f.length ? " (filters: " + f.join(", ") + ")" : "") + scope;
}

function setAsideSentence_(counts) {
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .map((k) => counts[k] + " " + k)
    .join(", ");
}

function countBy_(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Notice text -> one clean quotable excerpt. */
function excerpt_(text) {
  if (!text) return "";
  const cleaned = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > EXCERPT_CHARS ? cleaned.slice(0, EXCERPT_CHARS - 1) + "…" : cleaned;
}

/** Drive-safe file/folder name. */
function safeName_(name) {
  const cleaned = String(name).replace(/[\\\/:*?"<>|#]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 90 ? cleaned.slice(0, 90).trim() : cleaned || "untitled";
}

/** ".pdf" or "application/pdf" -> a usable extension. */
function extFor_(mime) {
  if (!mime) return "";
  if (mime.charAt(0) === ".") return mime;
  const map = {"application/pdf": ".pdf", "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx"};
  return map[mime] || "";
}

function dateOnly_(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

function money_(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

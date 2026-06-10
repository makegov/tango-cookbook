// Non-secret prefs (URLs, active env) in sync storage.
const SYNC_DEFAULTS = {
  envs: {
    Production: {url: "https://tango.makegov.com"},
  },
  activeEnv: "Production",
};

// API keys stored locally only — never synced to Google account.
const LOCAL_KEY_DEFAULTS = {keys: {Production: ""}};

const ENTITY_SHAPE = "uei,legal_business_name,dba_name,display_name,entity_url," +
"physical_address(*),registration_status,primary_naics,federal_obligations(*)";
const CONTRACT_SHAPE = "key,piid,award_date,description,total_contract_value,obligated," +
"set_aside(*),recipient(uei,display_name),awarding_office(*),period_of_performance(*)";
const IDV_SHAPE = "key,piid,award_date,description,total_contract_value,obligated," +
"idv_type(*),recipient(uei,display_name),awarding_office(*)";
const OPPORTUNITY_SHAPE = "opportunity_id,title,solicitation_number,active," +
"response_deadline,first_notice_date,last_notice_date,set_aside,naics_code,psc_code,sam_url," +
"agency(name,code),office(office_name,office_code)";

let config = {};
let activeEnv = "Production";

const searchBox = document.getElementById("searchBox");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const envBar = document.getElementById("envBar");
let debounceTimer;

// --- Init ---
chrome.storage.sync.get(SYNC_DEFAULTS, (syncData) => {
  chrome.storage.local.get(LOCAL_KEY_DEFAULTS, (localData) => {
    // Merge URLs from sync storage with keys from local storage.
    const keys = localData.keys || {};
    config = {};
    for (const name of Object.keys(syncData.envs)) {
      config[name] = {url: syncData.envs[name].url, key: keys[name] || ""};
    }
    activeEnv = syncData.activeEnv;
    renderEnvBar();

    // Check for pending query from context menu
    chrome.storage.local.get("pendingQuery", (local) => {
      if (local.pendingQuery) {
        searchBox.value = local.pendingQuery;
        chrome.storage.local.remove("pendingQuery");
        doLookup(local.pendingQuery);
      }
    });
  });
});

// --- Environment bar ---
function renderEnvBar() {
  envBar.innerHTML = "";
  for (const name of Object.keys(config)) {
    const btn = document.createElement("button");
    btn.className = "env-btn" + (name === activeEnv ? " active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      activeEnv = name;
      chrome.storage.sync.set({activeEnv});
      renderEnvBar();
    });
    envBar.appendChild(btn);
  }
}

function getConfig() {
  return config[activeEnv] || {url: "", key: ""};
}

// --- Search ---
searchBox.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doLookup(searchBox.value.trim()), 300);
});
searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(debounceTimer);
    doLookup(searchBox.value.trim());
  }
});

// --- API ---
const permissionCache = {};

async function ensureHostPermission(baseUrl) {
  const origin = new URL(baseUrl).origin + "/*";
  if (permissionCache[origin]) return;
  const granted = await chrome.permissions.contains({origins: [origin]});
  if (!granted) {
    await chrome.permissions.request({origins: [origin]});
  }
  permissionCache[origin] = true;
}

// Last failure from an API call, so an auth/network problem isn't
// indistinguishable from a genuinely empty result set. 404s are expected
// (exact-match lookups miss constantly) and are not recorded.
let lastRequestError = null;

function recordFailure(resp) {
  if (resp.status !== 404) lastRequestError = {status: resp.status};
}

async function apiFetch(path) {
  const cfg = getConfig();
  if (!cfg.key) return null;
  await ensureHostPermission(cfg.url);
  const url = cfg.url + path;
  let resp;
  try {
    resp = await fetch(url, {headers: {"X-API-KEY": cfg.key}});
  } catch (_) {
    lastRequestError = {network: true};
    return null;
  }
  if (!resp.ok) { recordFailure(resp); return null; }
  return resp.json();
}

async function apiPost(path, body) {
  const cfg = getConfig();
  if (!cfg.key) return null;
  await ensureHostPermission(cfg.url);
  const url = cfg.url + path;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {"X-API-KEY": cfg.key, "Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
  } catch (_) {
    lastRequestError = {network: true};
    return null;
  }
  if (!resp.ok) { recordFailure(resp); return null; }
  return resp.json();
}

let lookupId = 0;
async function doLookup(q) {
  const thisLookup = ++lookupId;
  resultsEl.innerHTML = "";
  if (!q) { statusEl.textContent = ""; return; }

  const cfg = getConfig();
  if (!cfg.key) {
    statusEl.innerHTML = 'No API key configured \u2014 <a href="#" id="openOpts" role="link">open settings</a>';
    document.getElementById("openOpts").addEventListener("click", (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
    return;
  }

  statusEl.textContent = "Searching\u2026";
  lastRequestError = null;

  const cards = [];
  const seen = new Set();
  function addCard(c) { if (c && !seen.has(c.id)) { seen.add(c.id); cards.push(c); } }

  // Phase 1: resolver for entities + exact lookups for awards/opportunities
  const [resolved, con, idv, sol] = await Promise.all([
    apiPost("/api/resolve/", {name: q, target_type: "entity"}).catch(() => null),
    apiFetch("/api/contracts/" + encodeURIComponent(q) + "/?shape=" + CONTRACT_SHAPE).catch(() => null),
    apiFetch("/api/idvs/" + encodeURIComponent(q) + "/?shape=" + IDV_SHAPE).catch(() => null),
    apiFetch("/api/opportunities/?solicitation_number=" + encodeURIComponent(q) + "&shape=" + OPPORTUNITY_SHAPE).catch(() => null),
  ]);

  // Fetch full entity details for each resolver candidate
  if (resolved?.candidates?.length) {
    const entityDetails = await Promise.all(
      resolved.candidates.map(c =>
        apiFetch("/api/entities/" + encodeURIComponent(c.identifier) + "/?shape=" + ENTITY_SHAPE).catch(() => null)
      )
    );
    entityDetails.forEach(d => { if (d) addCard(entityCard(d)); });
  }

  if (con) addCard(awardCard(con, "contract"));
  if (idv) addCard(awardCard(idv, "idv"));
  if (sol?.results) sol.results.slice(0, 5).forEach(d => addCard(opportunityCard(d)));

  if (thisLookup !== lookupId) return;

  // Phase 2: text search for awards/opportunities if no hits yet
  if (cards.length === 0) {
    const [sCon, sIdv, sOpp] = await Promise.all([
      apiFetch("/api/contracts/?search=" + encodeURIComponent(q) + "&shape=" + CONTRACT_SHAPE).catch(() => null),
      apiFetch("/api/idvs/?search=" + encodeURIComponent(q) + "&shape=" + IDV_SHAPE).catch(() => null),
      apiFetch("/api/opportunities/?search=" + encodeURIComponent(q) + "&shape=" + OPPORTUNITY_SHAPE).catch(() => null),
    ]);
    if (sCon?.results) sCon.results.slice(0, 5).forEach(d => addCard(awardCard(d, "contract")));
    if (sIdv?.results) sIdv.results.slice(0, 5).forEach(d => addCard(awardCard(d, "idv")));
    if (sOpp?.results) sOpp.results.slice(0, 5).forEach(d => addCard(opportunityCard(d)));
  }

  if (thisLookup !== lookupId) return;

  if (cards.length === 0) {
    if (lastRequestError?.status === 401 || lastRequestError?.status === 403) {
      statusEl.innerHTML = 'API key rejected (HTTP ' + lastRequestError.status + ') — <a href="#" id="openOpts" role="link">open settings</a>';
      document.getElementById("openOpts").addEventListener("click", (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
    } else if (lastRequestError?.network) {
      statusEl.textContent = "Network error — could not reach " + getConfig().url;
    } else if (lastRequestError) {
      statusEl.textContent = "API error (HTTP " + lastRequestError.status + ")";
    } else {
      statusEl.textContent = 'No results for "' + q + '"';
    }
  } else {
    statusEl.textContent = "";
    cards.forEach(c => resultsEl.insertAdjacentHTML("beforeend", c.html));
  }
}

// --- Card renderers ---
function entityCard(d) {
  const addr = d.physical_address || {};
  const loc = [addr.city, addr.state_or_province_code].filter(Boolean).join(", ") || "\u2014";
  const fo = d.federal_obligations?.total || {};
  // registration_status is a boolean in the API
  const status = d.registration_status === true ? "Active"
    : d.registration_status === false ? "Inactive"
    : (d.registration_status || "\u2014");
  return {id: "entity:" + d.uei, html: `
    <div class="card">
      <span class="card-badge entity">Entity</span>
      <div class="card-title">${esc(d.display_name)}</div>
      <div class="card-id">${esc(d.uei)}</div>
      <div class="card-ext"><a href="https://sam.gov/entities/view/${encodeURIComponent(d.uei)}/coreData" target="_blank" rel="noopener">SAM.gov &#x2197;</a></div>
      <div class="card-grid">
        <div><div class="field-label">Location</div><div class="field-value">${esc(loc)}</div></div>
        <div><div class="field-label">Status</div><div class="field-value">${esc(status)}</div></div>
        <div><div class="field-label">Primary NAICS</div><div class="field-value">${esc(d.primary_naics || "\u2014")}</div></div>
        <div><div class="field-label">Website</div><div class="field-value">${safeUrl(d.entity_url)}</div></div>
        <div><div class="field-label">Awards</div><div class="field-value">${fmt(fo.awards_count || 0)} awards</div></div>
        <div><div class="field-label">Obligated</div><div class="field-value">${dollar(fo.awards_obligated)}</div></div>
      </div>
      <button class="expand-btn" data-type="entity" data-id="${esc(d.uei)}">Expand</button>
      <div class="raw-json"></div>
    </div>`};
}

function awardCard(d, badge) {
  const label = badge === "idv" ? "IDV" : "Contract";
  const recipientHtml = d.recipient
    ? '<a href="#" class="lookup-link" role="link" data-q="' + esc(d.recipient.uei) + '">' + esc(truncate(d.recipient.display_name, 28)) + '</a>'
    : "\u2014";
  const office = d.awarding_office?.office_name || "\u2014";
  const desc = d.description ? '<div class="card-desc">' + esc(truncate(d.description, 100)) + '</div>' : "";

  let extraFields = "";
  if (badge === "contract") {
    const sa = d.set_aside?.description || d.set_aside || "\u2014";
    const popStart = d.period_of_performance?.start_date || "\u2014";
    const popEnd = d.period_of_performance?.current_end_date || "\u2014";
    extraFields = `
      <div><div class="field-label">Set-Aside</div><div class="field-value">${esc(String(sa))}</div></div>
      <div><div class="field-label">PoP</div><div class="field-value">${esc(popStart)} \u2013 ${esc(popEnd)}</div></div>`;
  } else {
    const idvType = d.idv_type?.description || d.idv_type || "\u2014";
    extraFields = `
      <div><div class="field-label">IDV Type</div><div class="field-value">${esc(String(idvType))}</div></div>
      <div><div class="field-label">Award Date</div><div class="field-value">${esc(d.award_date || "\u2014")}</div></div>`;
  }

  return {id: badge + ":" + d.key, html: `
    <div class="card">
      <span class="card-badge ${badge}">${label}</span>
      <div class="card-title">${esc(d.piid)}</div>
      <div class="card-id">${esc(d.key)}</div>
      <div class="card-ext"><a href="https://www.usaspending.gov/award/${encodeURIComponent(d.key)}" target="_blank" rel="noopener">USASpending &#x2197;</a></div>
      ${desc}
      <div class="card-grid">
        <div><div class="field-label">Total Value</div><div class="field-value">${dollar(d.total_contract_value)}</div></div>
        <div><div class="field-label">Obligated</div><div class="field-value">${dollar(d.obligated)}</div></div>
        <div><div class="field-label">Recipient</div><div class="field-value">${recipientHtml}</div></div>
        <div><div class="field-label">Awarding Office</div><div class="field-value">${esc(truncate(office, 28))}</div></div>
        ${extraFields}
      </div>
      <button class="expand-btn" data-type="${badge}" data-id="${esc(d.key)}">Expand</button>
      <div class="raw-json"></div>
    </div>`};
}

function opportunityCard(d) {
  const agency = d.agency?.name || "\u2014";
  const office = d.office?.office_name || "";
  const status = d.active ? "Active" : "Inactive";
  const solNum = d.solicitation_number || "\u2014";
  const deadline = d.response_deadline || "\u2014";
  const samLink = d.sam_url
    ? '<div class="card-ext"><a href="' + esc(d.sam_url) + '" target="_blank" rel="noopener">SAM.gov &#x2197;</a></div>'
    : "";
  return {id: "opportunity:" + d.opportunity_id, html: `
    <div class="card">
      <span class="card-badge opportunity">Opportunity</span>
      <div class="card-title">${esc(d.title || "\u2014")}</div>
      <div class="card-id">${esc(solNum)}</div>
      ${samLink}
      <div class="card-grid">
        <div><div class="field-label">Agency</div><div class="field-value">${esc(truncate(agency, 28))}</div></div>
        <div><div class="field-label">Status</div><div class="field-value">${esc(status)}</div></div>
        <div><div class="field-label">Response Deadline</div><div class="field-value">${esc(deadline)}</div></div>
        <div><div class="field-label">Posted</div><div class="field-value">${esc(d.first_notice_date || "\u2014")}</div></div>
        <div><div class="field-label">NAICS</div><div class="field-value">${esc(d.naics_code || "\u2014")}</div></div>
        <div><div class="field-label">Set-Aside</div><div class="field-value">${esc(d.set_aside || "\u2014")}</div></div>${office ? `
    <div><div class="field-label">Office</div><div class="field-value">${esc(truncate(office, 28))}</div></div>` : ""}
      </div>
      <button class="expand-btn" data-type="opportunity" data-id="${esc(d.opportunity_id)}">Expand</button>
      <div class="raw-json"></div>
    </div>`};
}

// --- Event delegation (no inline onclick in extensions) ---
document.addEventListener("click", async (e) => {
  // Expand/collapse
  if (e.target.classList.contains("expand-btn")) {
    const btn = e.target;
    const jsonEl = btn.nextElementSibling;
    if (jsonEl.classList.contains("open")) {
      jsonEl.classList.remove("open");
      btn.textContent = "Expand";
      return;
    }
    btn.textContent = "Loading\u2026";
    const type = btn.dataset.type;
    const id = btn.dataset.id;
    const pathMap = {entity: "/api/entities/", contract: "/api/contracts/", idv: "/api/idvs/", opportunity: "/api/opportunities/"};
    const data = await apiFetch(pathMap[type] + encodeURIComponent(id) + "/").catch(() => null);
    if (data) {
      jsonEl.innerHTML = renderExpandedData(data, 0);
    } else {
      jsonEl.textContent = "Failed to load full response.";
    }
    jsonEl.classList.add("open");
    btn.textContent = "Collapse";
    return;
  }

  // Collapsible sub-sections in expanded data
  if (e.target.classList.contains("kv-group-label")) {
    const group = e.target.parentElement;
    if (group && group.classList.contains("kv-group")) {
      group.classList.toggle("collapsed");
    }
    return;
  }

  // Recipient lookup link
  if (e.target.classList.contains("lookup-link")) {
    e.preventDefault();
    const q = e.target.dataset.q;
    searchBox.value = q;
    doLookup(q);
    return;
  }
});

// --- Expanded data renderer ---
function humanizeKey(key) {
  return String(key).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function renderExpandedData(obj, depth) {
  if (depth == null) depth = 0;
  if (depth >= 3) {
    return '<div class="kv-value">' + esc(JSON.stringify(obj, null, 2)) + '</div>';
  }
  if (obj == null) return "";
  if (typeof obj !== "object") {
    return '<div class="kv-value">' + esc(String(obj)) + '</div>';
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<div class="kv-value">(empty)</div>';
    var html = "";
    for (var i = 0; i < obj.length; i++) {
      var item = obj[i];
      if (item != null && typeof item === "object" && !Array.isArray(item)) {
        html += '<div class="kv-group">' +
        '<div class="kv-group-label">' + esc(String(i + 1)) + '</div>' +
        renderExpandedData(item, depth + 1) +
        '</div>';
      } else {
        html += '<div class="kv-row">' +
        '<span class="kv-label">' + esc(String(i + 1)) + '</span>' +
        '<span class="kv-value">' + esc(String(item)) + '</span>' +
        '</div>';
      }
    }
    return html;
  }
  var keys = Object.keys(obj);
  var html = "";
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var val = obj[key];
    if (val == null) {
      html += '<div class="kv-row">' +
      '<span class="kv-label">' + esc(humanizeKey(key)) + '</span>' +
      '<span class="kv-value">\u2014</span>' +
      '</div>';
    } else if (typeof val === "object") {
      html += '<div class="kv-group">' +
      '<div class="kv-group-label">' + esc(humanizeKey(key)) + '</div>' +
      renderExpandedData(val, depth + 1) +
      '</div>';
    } else {
      html += '<div class="kv-row">' +
      '<span class="kv-label">' + esc(humanizeKey(key)) + '</span>' +
      '<span class="kv-value">' + esc(String(val)) + '</span>' +
      '</div>';
    }
  }
  return html;
}

// --- Helpers ---
function safeUrl(url) {
  if (!url) return "\u2014";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return esc(url);
  } catch (_) {
    return esc(url);
  }
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(truncate(url, 28)) + '</a>';
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function fmt(n) {
  return Number(n).toLocaleString();
}

function dollar(n) {
  if (n == null) return "\u2014";
  return "$" + Math.round(Number(n)).toLocaleString();
}

function truncate(s, len) {
  if (!s) return "";
  return s.length > len ? s.slice(0, len) + "\u2026" : s;
}

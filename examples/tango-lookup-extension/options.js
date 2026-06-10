// Non-secret prefs (URLs, active env) in sync storage.
const SYNC_DEFAULTS = {
  envs: {
    Production: {url: "https://tango.makegov.com"},
  },
  activeEnv: "Production",
};

// API keys stored locally only — never synced to Google account.
const LOCAL_DEFAULTS = {
  keys: {Production: ""},
};

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(SYNC_DEFAULTS, (syncData) => {
    chrome.storage.local.get(LOCAL_DEFAULTS, (localData) => {
      document.getElementById("prodUrl").value = syncData.envs.Production?.url || "";
      document.getElementById("prodKey").value = localData.keys?.Production || "";
    });
  });

  document.getElementById("saveBtn").addEventListener("click", () => {
    const envs = {
      Production: {url: document.getElementById("prodUrl").value.replace(/\/+$/, "")},
    };
    const keys = {
      Production: document.getElementById("prodKey").value.trim(),
    };
    chrome.storage.sync.set({envs}, () => {
      chrome.storage.local.set({keys}, () => {
        const msg = document.getElementById("statusMsg");
        msg.style.display = "block";
        setTimeout(() => msg.style.display = "none", 1500);
      });
    });
  });
});

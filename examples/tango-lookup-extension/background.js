// Context menu: right-click selected text -> "Lookup in Tango"
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tango-lookup",
    title: "Lookup \"%s\" in Tango",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "tango-lookup" && info.selectionText) {
    const q = info.selectionText.trim();
    chrome.storage.local.set({pendingQuery: q}, () => {
      const popupURL = chrome.runtime.getURL("popup.html");
      chrome.tabs.create({url: popupURL});
    });
  }
});

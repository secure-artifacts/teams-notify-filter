chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  const url = tab.url || "";
  if (!/teams\.(microsoft|live)\.com/i.test(url)) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TEAMS_PANEL" }).catch(() => {});
});

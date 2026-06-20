let scanScheduled = false;
let observerStarted = false;
let cachedCatalog = {};
let isMonitorTab = true;
let filterEnabled = true;

registerMonitorTab();
loadSettings().finally(() => {
  startRealtimeWatch();
  scanAndReport().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    cachedCatalog = changes.config.newValue?.threadCatalog || {};
    filterEnabled = changes.config.newValue?.enabled !== false;
    scheduleScan();
  }
});

window.addEventListener("teams-notify-wake-scan", () => {
  scanAndReport().catch(() => {});
});

window.addEventListener("pageshow", () => {
  registerMonitorTab();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    registerMonitorTab();
    scanAndReport().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TEAMS_WAKE_SCAN") {
    scanAndReport()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "扫描失败" }));
    return true;
  }
  if (message?.type === "TEAMS_MONITOR_PROMOTED") {
    registerMonitorTab(() => {
      scanAndReport().catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function loadSettings() {
  const { config } = await chrome.storage.local.get(["config"]);
  cachedCatalog = config?.threadCatalog || {};
  filterEnabled = config?.enabled !== false;
}

function registerMonitorTab(onDone) {
  chrome.runtime.sendMessage({ type: "TEAMS_REGISTER_TAB" }, (response) => {
    if (response?.isMonitor === false) isMonitorTab = false;
    else if (response?.isMonitor === true) isMonitorTab = true;
    void chrome.runtime.lastError;
    onDone?.();
  });
}

function startRealtimeWatch() {
  if (observerStarted) return;
  observerStarted = true;

  const root = document.documentElement || document.body;
  if (!root) return;

  const observer = new MutationObserver((mutations) => {
    if (!mutations.length) return;
    scheduleScan();
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "class", "data-tid", "data-conversation-id", "href"],
    characterData: true,
  });

  watchDocumentTitle();
}

function watchDocumentTitle() {
  let lastTitle = document.title;
  const titleEl = document.querySelector("title");
  if (!titleEl) return;

  const titleObserver = new MutationObserver(() => {
    if (document.title === lastTitle) return;
    lastTitle = document.title;
    scheduleScan();
  });

  titleObserver.observe(titleEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    scanAndReport().catch(() => {});
  });
}

async function scanAndReport() {
  if (!isMonitorTab || !filterEnabled) return;
  const utils = window.TeamsNotifyUtils;
  if (!utils) return;
  const threads = utils.collectAllThreads(cachedCatalog);
  await sendMessage("TEAMS_UNREAD_SNAPSHOT", { threads });
}

function sendMessage(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "请求失败"));
        return;
      }
      resolve(response);
    });
  });
}

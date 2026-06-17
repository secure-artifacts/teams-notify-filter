let scanScheduled = false;
let observerStarted = false;

registerMonitorTab();
startRealtimeWatch();
scanAndReport().catch(() => {});

window.addEventListener("teams-notify-wake-scan", () => {
  scanAndReport().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TEAMS_WAKE_SCAN") {
    scanAndReport()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "扫描失败" }));
    return true;
  }
  return false;
});

function registerMonitorTab() {
  chrome.runtime.sendMessage({ type: "TEAMS_REGISTER_TAB" }, () => {
    void chrome.runtime.lastError;
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
    attributeFilter: ["aria-label", "class", "data-tid"],
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
  const threads = collectUnreadThreads();
  await sendMessage("TEAMS_UNREAD_SNAPSHOT", { threads });
}

function collectUnreadThreads() {
  const candidates = [...document.querySelectorAll('[role="treeitem"], [role="listitem"]')];
  const result = [];

  for (const item of candidates) {
    const unreadCount = extractUnreadCount(item);
    if (unreadCount <= 0) continue;

    const title = extractThreadTitle(item);
    if (!title) continue;

    const chatType = detectChatType(item, title);
    const id = extractThreadId(item, title, chatType);
    result.push({ id, title, unreadCount, chatType });
  }

  return dedupeThreads(result);
}

function extractUnreadCount(node) {
  const ariaText = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.toLowerCase();
  const knownPatterns = [/(\d+)\s*unread/, /未读\s*(\d+)/, /(\d+)\s*new messages?/];
  for (const pattern of knownPatterns) {
    const match = ariaText.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }

  const badge = node.querySelector('[aria-label*="unread"], [data-tid*="unread"], [class*="unread"]');
  if (!badge) return 0;
  const text = (badge.textContent || "").trim();
  if (!text) return 1;
  const num = Number(text.replace(/[^\d]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : 1;
}

function extractThreadTitle(node) {
  const titleSelectors = [
    '[data-tid*="chat-list-item-title"]',
    '[data-tid*="thread-title"]',
    '[class*="title"]',
    '[class*="name"]',
  ];
  for (const selector of titleSelectors) {
    const el = node.querySelector(selector);
    const text = (el?.textContent || "").trim();
    if (text) return text;
  }

  const ariaLabel = (node.getAttribute("aria-label") || "").trim();
  if (ariaLabel) return ariaLabel.split(/,|，/)[0].trim();
  return "";
}

function detectChatType(node, title) {
  const text = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.toLowerCase();
  if (
    /private|direct message|1:1|个人|私人|单聊/.test(text) &&
    !/group|group chat|群聊|团队/.test(text)
  ) {
    return "private";
  }
  if (/group|group chat|群聊|团队|channel/.test(text)) {
    return "group";
  }

  if (/[,，]| and /i.test(title)) return "group";
  return "group";
}

function extractThreadId(node, title, chatType) {
  const attrCandidates = [
    node.getAttribute("data-tid"),
    node.getAttribute("id"),
    node.getAttribute("data-id"),
    node.getAttribute("data-item-id"),
  ];
  for (const attr of attrCandidates) {
    const value = String(attr || "").trim();
    if (value) return value;
  }
  return `${chatType}:${title.toLowerCase()}`;
}

function dedupeThreads(threads) {
  const map = new Map();
  for (const thread of threads) {
    const existing = map.get(thread.id);
    if (!existing || thread.unreadCount > existing.unreadCount) {
      map.set(thread.id, thread);
    }
  }
  return [...map.values()];
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

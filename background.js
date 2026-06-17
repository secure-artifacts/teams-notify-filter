const DEFAULT_CONFIG = {
  enabled: true,
  allowedGroups: [],
};

const THREAD_STATE_KEY = "threadStateMap";
const TEAMS_MONITOR_TAB_KEY = "teamsMonitorTabId";
const TEAMS_HOME_URL = "https://teams.microsoft.com/";

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get(["config"]);
  if (!config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  const cfg = await getConfig();
  if (cfg.enabled) {
    ensureTeamsMonitorTab(true).catch(() => {});
    syncMonitorTab(cfg).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  getConfig().then((cfg) => {
    if (cfg.enabled) {
      ensureTeamsMonitorTab(true).catch(() => {});
      syncMonitorTab(cfg).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type === "GET_CONFIG") {
    getConfig().then((config) => sendResponse({ ok: true, config }));
    return true;
  }

  if (type === "SAVE_CONFIG") {
    saveConfig(message?.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "保存失败" }));
    return true;
  }

  if (type === "TEAMS_UNREAD_SNAPSHOT") {
    handleUnreadSnapshot(message?.threads || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "处理失败" }));
    return true;
  }

  if (type === "TEAMS_REGISTER_TAB") {
    const tabId = sender?.tab?.id;
    if (tabId) {
      chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: tabId });
      setTabUndiscardable(tabId).catch(() => {});
    }
    sendResponse({ ok: true, tabId });
    return false;
  }

  if (type === "OPEN_TEAMS_TAB") {
    openTeamsTab(message?.active !== false)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "打开失败" }));
    return true;
  }

  if (type === "GET_MONITOR_STATUS") {
    getMonitorStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "获取状态失败" }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY], (data) => {
    if (data[TEAMS_MONITOR_TAB_KEY] === tabId) {
      chrome.storage.local.remove(TEAMS_MONITOR_TAB_KEY);
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.config) return;
  const cfg = changes.config.newValue;
  if (cfg?.enabled) {
    ensureTeamsMonitorTab(true).catch(() => {});
    syncMonitorTab(cfg).catch(() => {});
  }
});

async function getConfig() {
  const { config } = await chrome.storage.local.get(["config"]);
  const normalized = { ...DEFAULT_CONFIG, ...(config || {}) };
  normalized.allowedGroups = dedupeGroupNames(normalized.allowedGroups || []);
  normalized.enabled = Boolean(normalized.enabled);
  return normalized;
}

async function saveConfig(partialConfig) {
  const current = await getConfig();
  const next = { ...current, ...partialConfig };
  next.allowedGroups = dedupeGroupNames(next.allowedGroups || []);
  next.enabled = Boolean(next.enabled);
  await chrome.storage.local.set({ config: next });
  if (next.enabled) {
    await ensureTeamsMonitorTab(true);
    syncMonitorTab(next).catch(() => {});
  }
  return next;
}

function dedupeGroupNames(names) {
  const seen = new Set();
  const result = [];
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(name);
  }
  return result;
}

async function syncMonitorTab(config) {
  if (!config?.enabled) return false;
  const tabId = await ensureTeamsMonitorTab(true);
  if (!tabId) return false;

  await setTabUndiscardable(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "TEAMS_WAKE_SCAN" });
    if (res?.ok) return true;
  } catch {
    /* content script may still be loading */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.dispatchEvent(new CustomEvent("teams-notify-wake-scan"));
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveTeamsMonitorTab() {
  const stored = await chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY]);
  const cachedId = stored[TEAMS_MONITOR_TAB_KEY];
  if (cachedId) {
    try {
      const tab = await chrome.tabs.get(cachedId);
      if (tab?.id && isTeamsUrl(tab.url)) return tab.id;
    } catch {
      await chrome.storage.local.remove(TEAMS_MONITOR_TAB_KEY);
    }
  }

  const tabs = await chrome.tabs.query({ url: ["*://teams.microsoft.com/*"] });
  const match = tabs.find((tab) => tab.id && isTeamsUrl(tab.url));
  if (match?.id) {
    await chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: match.id });
    return match.id;
  }
  return null;
}

async function ensureTeamsMonitorTab(createIfMissing) {
  const existing = await resolveTeamsMonitorTab();
  if (existing) {
    await setTabUndiscardable(existing);
    return existing;
  }
  if (!createIfMissing) return null;

  const tab = await chrome.tabs.create({ url: TEAMS_HOME_URL, active: false });
  await setTabUndiscardable(tab.id);
  await chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: tab.id });
  return tab.id;
}

async function openTeamsTab(active = true) {
  const tabId = await ensureTeamsMonitorTab(true);
  await chrome.tabs.update(tabId, { active });
  await syncMonitorTab(await getConfig());
  return { tabId, created: false };
}

async function getMonitorStatus() {
  const config = await getConfig();
  const tabId = await resolveTeamsMonitorTab();
  if (!tabId) {
    return { enabled: config.enabled, hasTab: false, tabActive: false, tabUrl: "" };
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    enabled: config.enabled,
    hasTab: true,
    tabActive: !!tab.active,
    tabUrl: tab.url || "",
  };
}

function isTeamsUrl(url) {
  try {
    return /teams\.microsoft\.com/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function setTabUndiscardable(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* older chrome may not support */
  }
}

async function handleUnreadSnapshot(threads) {
  const config = await getConfig();
  if (!config.enabled) return { notified: 0 };

  const { [THREAD_STATE_KEY]: prevStateRaw } = await chrome.storage.local.get([THREAD_STATE_KEY]);
  const prevState = prevStateRaw || {};
  const nextState = {};
  let notified = 0;

  for (const thread of threads) {
    const id = String(thread?.id || "").trim();
    if (!id) continue;

    const title = String(thread?.title || "Teams 会话").trim() || "Teams 会话";
    const unreadCount = Math.max(0, Number(thread?.unreadCount) || 0);
    const chatType = normalizeChatType(thread?.chatType);
    const prevUnread = Number(prevState[id]?.unreadCount || 0);
    const shouldNotifyThisThread =
      unreadCount > 0 && unreadCount > prevUnread && shouldNotifyByRule(chatType, title, config);

    if (shouldNotifyThisThread) {
      notified += 1;
      createNotification(title, unreadCount, chatType);
    }

    nextState[id] = {
      unreadCount,
      title,
      chatType,
      updatedAt: Date.now(),
    };
  }

  await chrome.storage.local.set({ [THREAD_STATE_KEY]: nextState });
  return { notified };
}

function normalizeChatType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "private" || normalized === "group") return normalized;
  return "unknown";
}

function shouldNotifyByRule(chatType, title, config) {
  if (chatType === "private") return true;
  if (chatType !== "group") return false;

  const titleLower = String(title || "").trim().toLowerCase();
  return (config.allowedGroups || []).some((groupName) => titleLower === groupName.toLowerCase());
}

function createNotification(title, unreadCount, chatType) {
  const kind = chatType === "private" ? "私人消息" : "群组消息";
  chrome.notifications.create({
    type: "basic",
    iconUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p6i/KkAAAAASUVORK5CYII=",
    title: `Teams ${kind}`,
    message: `${title}（未读 ${unreadCount}）`,
  });
}

getConfig().then((cfg) => {
  if (cfg.enabled) {
    ensureTeamsMonitorTab(true).catch(() => {});
    syncMonitorTab(cfg).catch(() => {});
  }
});

const DEFAULT_CONFIG = {
  enabled: true,
  notifyThreadIds: [],
  notifyThreadTitles: [],
  threadCatalog: {},
};

const THREAD_STATE_KEY = "threadStateMap";
const TEAMS_MONITOR_TAB_KEY = "teamsMonitorTabId";
const MAX_CATALOG_ENTRIES = 500;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_ALARM = "teams-notify-heartbeat";
const HEARTBEAT_MINUTES = 1.5;
const NOTIFICATION_DEDUPE_MS = 15000;

/** 防止并发调用各自新建标签 */
let ensureTabPromise = null;

function isTrustedSender(sender) {
  return sender?.id === chrome.runtime.id;
}

function isTeamsTabSender(sender) {
  if (!isTrustedSender(sender)) return false;
  const url = sender.tab?.url || "";
  return isTeamsUrl(url);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get(["config"]);
  if (!config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  await scheduleHeartbeat();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleHeartbeat().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    heartbeatTick().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.id || !isTeamsUrl(tab.url)) return;
  resolveTeamsMonitorTab().then((monitorId) => {
    if (!monitorId) registerMonitorTabId(tabId);
  });
  injectNotificationGuard(tabId).catch(() => {});
  getConfig()
    .then((config) => syncMonitorTab(config))
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: "未授权的消息来源" });
    return false;
  }

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
    if (!isTeamsTabSender(sender)) {
      sendResponse({ ok: false, error: "仅接受 Teams 页面的快照" });
      return false;
    }
    handleUnreadSnapshot(message?.threads || [], sender.tab?.id)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "处理失败" }));
    return true;
  }

  if (type === "TEAMS_SYNC_CATALOG") {
    if (!isTeamsTabSender(sender)) {
      sendResponse({ ok: false, error: "仅接受 Teams 页面的目录同步" });
      return false;
    }
    syncThreadCatalog(message?.threads || [])
      .then((catalog) => sendResponse({ ok: true, catalog }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "同步失败" }));
    return true;
  }

  if (type === "TEAMS_REGISTER_TAB") {
    if (!isTeamsTabSender(sender)) {
      sendResponse({ ok: false, error: "仅接受 Teams 页面注册" });
      return false;
    }
    const tabId = sender?.tab?.id;
    claimMonitorTab(tabId)
      .then((isMonitor) => sendResponse({ ok: true, tabId, isMonitor }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "注册失败" }));
    return true;
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

  if (type === "TEAMS_GUARD_INJECT_FAILED") {
    if (isTeamsTabSender(sender) && sender.tab?.id) {
      injectNotificationGuard(sender.tab.id).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY], async (data) => {
    if (data[TEAMS_MONITOR_TAB_KEY] !== tabId) return;
    await chrome.storage.local.remove(TEAMS_MONITOR_TAB_KEY);
    const teamsTabs = await findAllTeamsTabs();
    for (const tab of teamsTabs) {
      if (!tab.id) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TEAMS_MONITOR_PROMOTED" });
      } catch {
        /* tab may not have content script yet */
      }
    }
  });
});

async function getConfig() {
  const { config } = await chrome.storage.local.get(["config"]);
  const normalized = { ...DEFAULT_CONFIG, ...(config || {}) };
  normalized.notifyThreadIds = dedupeIds(normalized.notifyThreadIds || []);
  normalized.notifyThreadTitles = dedupeTitles(normalized.notifyThreadTitles || []);
  normalized.threadCatalog = normalized.threadCatalog || {};
  normalized.enabled = Boolean(normalized.enabled);
  return normalized;
}

async function saveConfig(partialConfig) {
  const current = await getConfig();
  const next = { ...current, ...partialConfig };
  next.notifyThreadIds = dedupeIds(next.notifyThreadIds || []);
  next.notifyThreadTitles = dedupeTitles(next.notifyThreadTitles || []);
  next.threadCatalog = next.threadCatalog || {};
  next.enabled = Boolean(next.enabled);
  await chrome.storage.local.set({ config: next });
  await scheduleHeartbeat();
  syncMonitorTab(next).catch(() => {});
  pushNotificationGuardConfig(next.enabled !== false).catch(() => {});
  return next;
}

async function pushNotificationGuardConfig(enabled) {
  const tabId = await resolveTeamsMonitorTab();
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (isEnabled) => {
        window.dispatchEvent(
          new CustomEvent("teams-notify-config", {
            detail: { enabled: isEnabled },
          })
        );
      },
      args: [enabled],
      world: "MAIN",
    });
  } catch {
    /* ignore */
  }
}

function dedupeIds(ids) {
  return [...new Set((ids || []).map((id) => String(id).trim()).filter(Boolean))];
}

function normalizeTitleKey(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dedupeTitles(titles) {
  return [...new Set((titles || []).map(normalizeTitleKey).filter(Boolean))];
}

async function scheduleHeartbeat() {
  const config = await getConfig();
  if (!config.enabled) {
    await chrome.alarms.clear(HEARTBEAT_ALARM);
    return;
  }
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
}

async function heartbeatTick() {
  const config = await getConfig();
  if (!config.enabled) return;
  await syncMonitorTab(config);
}

function registerMonitorTabId(tabId) {
  if (!tabId) return;
  chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: tabId });
  setTabUndiscardable(tabId).catch(() => {});
}

async function claimMonitorTab(tabId) {
  if (!tabId) return false;

  const stored = await chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY]);
  let monitorId = stored[TEAMS_MONITOR_TAB_KEY];

  if (monitorId) {
    try {
      const tab = await chrome.tabs.get(monitorId);
      if (!tab?.id || !isTeamsUrl(tab.url)) monitorId = null;
    } catch {
      monitorId = null;
    }
  }

  if (monitorId && monitorId !== tabId) return false;

  if (!monitorId) {
    await chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: tabId });
    const verify = await chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY]);
    if (verify[TEAMS_MONITOR_TAB_KEY] !== tabId) return false;
  }

  registerMonitorTabId(tabId);
  return true;
}

function isLoginUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes("login.microsoftonline.com") ||
      host.includes("login.live.com") ||
      host.includes("login.microsoft.com")
    );
  } catch {
    return false;
  }
}

function isTeamsUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (isLoginUrl(url)) return false;
    return host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com");
  } catch {
    return false;
  }
}

function isTeamsLoginUrl(url) {
  if (!isLoginUrl(url)) return false;
  const lower = String(url || "").toLowerCase();
  return (
    lower.includes("teams.microsoft.com") ||
    lower.includes("teams.live.com") ||
    lower.includes("microsoftteams") ||
    lower.includes("1fec8e78-b456-4f79-90fe-575705da6696")
  );
}

function isTeamsRelatedUrl(url) {
  return isTeamsUrl(url) || isTeamsLoginUrl(url);
}

async function findAllTeamsRelatedTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id && tab.url && isTeamsRelatedUrl(tab.url))
    .sort((a, b) => {
      const score = (t) => {
        let s = 0;
        if (t.active) s += 8;
        if (isTeamsUrl(t.url)) s += 16;
        if (t.url?.includes("/v2") || t.url?.includes("/dl/launcher")) s += 4;
        if (isTeamsLoginUrl(t.url)) s += 1;
        return s;
      };
      return score(b) - score(a);
    });
}

async function findAllTeamsTabs() {
  const tabs = await findAllTeamsRelatedTabs();
  return tabs.filter((tab) => isTeamsUrl(tab.url));
}

async function resolveTeamsMonitorTab() {
  const stored = await chrome.storage.local.get([TEAMS_MONITOR_TAB_KEY]);
  const cachedId = stored[TEAMS_MONITOR_TAB_KEY];
  if (cachedId) {
    try {
      const tab = await chrome.tabs.get(cachedId);
      if (tab?.id && tab.url && isTeamsRelatedUrl(tab.url)) return tab.id;
    } catch {
      await chrome.storage.local.remove(TEAMS_MONITOR_TAB_KEY);
    }
  }

  const teamsTabs = await findAllTeamsRelatedTabs();
  if (teamsTabs.length) {
    const match = teamsTabs[0];
    await chrome.storage.local.set({ [TEAMS_MONITOR_TAB_KEY]: match.id });
    return match.id;
  }
  return null;
}

async function focusTeamsTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return tab;
}

async function ensureTeamsMonitorTab(createIfMissing) {
  const existing = await resolveTeamsMonitorTab();
  if (existing) {
    await setTabUndiscardable(existing);
    return existing;
  }
  if (!createIfMissing) return null;

  if (ensureTabPromise) return ensureTabPromise;

  ensureTabPromise = (async () => {
    try {
      const again = await resolveTeamsMonitorTab();
      if (again) return again;

      throw new Error("未找到已打开的 Teams 标签页，请手动在 Chrome 打开 teams.microsoft.com");
    } finally {
      ensureTabPromise = null;
    }
  })();

  return ensureTabPromise;
}

async function setTabUndiscardable(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* ignore */
  }
}

async function waitForPanelMessage(tabId, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "TEAMS_PANEL_REFRESH" });
      if (res?.ok) return true;
    } catch {
      /* content script loading */
    }
    await sleep(400 + i * 200);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openTeamsTab(active = true) {
  let tabId = await resolveTeamsMonitorTab();
  if (!tabId) {
    throw new Error("请先在 Chrome 打开 teams.microsoft.com 并登录，再点此按钮切换过去（不会新建登录页）");
  }

  const tab = await focusTeamsTab(tabId);
  const onLoginPage = isTeamsLoginUrl(tab.url);

  if (active && isTeamsUrl(tab.url)) {
    await waitForPanelMessage(tabId);
  }

  return {
    tabId,
    reused: true,
    onLoginPage,
    needsManualLogin: onLoginPage,
  };
}

async function injectNotificationGuard(tabId) {
  const config = await getConfig();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["notification-guard-page.js"],
      world: "MAIN",
    });
  } catch {
    /* guard may already be installed */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (enabled) => {
        window.dispatchEvent(
          new CustomEvent("teams-notify-config", {
            detail: { enabled },
          })
        );
      },
      args: [config.enabled !== false],
      world: "MAIN",
    });
  } catch {
    /* ignore */
  }
}

async function syncMonitorTab(config) {
  if (!config?.enabled) return false;
  const tabId = await resolveTeamsMonitorTab();
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

async function syncThreadCatalog(threads) {
  const config = await getConfig();
  const catalog = { ...(config.threadCatalog || {}) };
  for (const thread of threads || []) {
    const id = String(thread?.id || "").trim();
    if (!id) continue;
    catalog[id] = {
      title: String(thread?.title || "").trim(),
      chatType: normalizeChatType(thread?.chatType),
      updatedAt: Date.now(),
    };
  }

  const migrated = migrateNotifyTargets(config, catalog);
  const trimmedCatalog = trimCatalog(catalog);

  const next = {
    ...config,
    ...migrated,
    threadCatalog: trimmedCatalog,
  };
  await chrome.storage.local.set({ config: next });
  return trimmedCatalog;
}

function trimCatalog(catalog) {
  const entries = Object.entries(catalog || {});
  if (entries.length <= MAX_CATALOG_ENTRIES) return catalog;
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_CATALOG_ENTRIES));
}

function migrateNotifyTargets(config, catalog) {
  const notifyIds = new Set(config.notifyThreadIds || []);
  const notifyTitles = new Set((config.notifyThreadTitles || []).map(normalizeTitleKey));

  for (const id of notifyIds) {
    const meta = catalog[id];
    if (meta?.title) notifyTitles.add(normalizeTitleKey(meta.title));
  }

  for (const [id, meta] of Object.entries(catalog)) {
    const titleKey = normalizeTitleKey(meta?.title);
    if (!titleKey || !notifyTitles.has(titleKey)) continue;
    notifyIds.add(id);
  }

  const nextIds = [...notifyIds];
  const nextTitles = [...notifyTitles];
  const idsChanged =
    nextIds.length !== (config.notifyThreadIds || []).length ||
    nextIds.some((id) => !(config.notifyThreadIds || []).includes(id));
  const titlesChanged =
    nextTitles.length !== (config.notifyThreadTitles || []).length ||
    nextTitles.some((t) => !(config.notifyThreadTitles || []).includes(t));

  if (!idsChanged && !titlesChanged) return {};
  return { notifyThreadIds: nextIds, notifyThreadTitles: nextTitles };
}

function pruneThreadState(state) {
  const cutoff = Date.now() - STATE_TTL_MS;
  const next = {};
  for (const [id, entry] of Object.entries(state || {})) {
    if ((entry?.updatedAt || 0) >= cutoff) next[id] = entry;
  }
  return next;
}

async function getMonitorStatus() {
  const config = await getConfig();
  const tabId = await resolveTeamsMonitorTab();
  if (!tabId) {
    return {
      enabled: config.enabled,
      hasTab: false,
      tabActive: false,
      tabUrl: "",
      notifyCount: config.notifyThreadIds.length,
    };
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    enabled: config.enabled,
    hasTab: true,
    tabActive: !!tab.active,
    tabUrl: tab.url || "",
    onLoginPage: isTeamsLoginUrl(tab.url),
    notifyCount: config.notifyThreadIds.length,
  };
}

async function handleUnreadSnapshot(threads, senderTabId) {
  const config = await getConfig();
  if (!config.enabled) return { notified: 0, skipped: threads.length };

  const monitorTabId = await resolveTeamsMonitorTab();
  if (monitorTabId && senderTabId && senderTabId !== monitorTabId) {
    return { notified: 0, skipped: threads.length, ignored: true };
  }

  const notifySet = new Set(config.notifyThreadIds || []);
  const notifyTitleSet = new Set((config.notifyThreadTitles || []).map(normalizeTitleKey));
  const { [THREAD_STATE_KEY]: prevStateRaw } = await chrome.storage.local.get([THREAD_STATE_KEY]);
  const prevState = pruneThreadState(prevStateRaw || {});
  const nextState = { ...prevState };
  let notified = 0;

  for (const thread of threads) {
    const id = String(thread?.id || "").trim();
    if (!id) continue;

    const title = String(thread?.title || "Teams 会话").trim() || "Teams 会话";
    const unreadCount = Math.max(0, Number(thread?.unreadCount) || 0);
    const chatType = normalizeChatType(thread?.chatType);
    const prevUnread = Number(prevState[id]?.unreadCount || 0);
    const shouldNotify =
      unreadCount > 0 &&
      unreadCount > prevUnread &&
      shouldNotifyThread({ id, chatType, title }, notifySet, notifyTitleSet);

    if (shouldNotify) {
      notified += 1;
      createNotification(id, title, unreadCount, chatType);
    }

    nextState[id] = { unreadCount, title, chatType, updatedAt: Date.now() };
  }

  await chrome.storage.local.set({ [THREAD_STATE_KEY]: nextState });
  return { notified };
}

function normalizeChatType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "private" || normalized === "group") return normalized;
  return "group";
}

function shouldNotifyThread(thread, notifySet, notifyTitleSet) {
  if (thread.chatType === "private") return true;
  if (thread.chatType !== "group") return false;
  if (notifySet.has(thread.id)) return true;
  return notifyTitleSet.has(normalizeTitleKey(thread.title));
}

const recentNotifications = new Map();

function pruneRecentNotifications() {
  const cutoff = Date.now() - NOTIFICATION_DEDUPE_MS * 4;
  for (const [id, at] of recentNotifications) {
    if (at < cutoff) recentNotifications.delete(id);
  }
}

function createNotification(threadId, title, unreadCount, chatType) {
  pruneRecentNotifications();
  const now = Date.now();
  const safeId = String(threadId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
  const lastAt = recentNotifications.get(safeId) || 0;
  if (now - lastAt < NOTIFICATION_DEDUPE_MS) return;
  recentNotifications.set(safeId, now);

  const kind = chatType === "private" ? "私人消息" : "群组消息";
  const notificationId = `teams-notify-${safeId}`.slice(0, 500);

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p6i/KkAAAAASUVORK5CYII=",
    title: `Teams ${kind}`,
    message: `${title}（未读 ${unreadCount}）`,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!String(notificationId).startsWith("teams-notify-")) return;
  const tabId = await resolveTeamsMonitorTab();
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* ignore */
  }
});

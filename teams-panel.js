(function () {
  const PANEL_ID = "teams-notify-panel";
  const TOGGLE_ID = "teams-notify-toggle";
  let config = { enabled: true, notifyThreadIds: [], notifyThreadTitles: [], threadCatalog: {} };
  let dragThreadId = null;
  let dragThreadTitle = "";
  let catalogSyncTimer = null;
  let lastCatalogSyncAt = 0;

  initPanel().catch((err) => console.warn("[teams-notify] panel init", err));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.config) {
      config = normalizeConfig(changes.config.newValue);
      renderPanel();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TEAMS_PANEL_REFRESH") {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.remove("hidden");
      renderPanel().then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  async function initPanel() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyles();
    injectToggle();
    injectPanelShell();
    await loadConfig();
    renderPanel();
    setInterval(() => {
      if (!document.getElementById(PANEL_ID)?.classList.contains("hidden")) {
        renderPanel();
      }
    }, 4000);
  }

  function injectStyles() {
    if (document.getElementById("teams-notify-panel-css")) return;
    const link = document.createElement("link");
    link.id = "teams-notify-panel-css";
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("teams-panel.css");
    document.head.appendChild(link);
  }

  function injectToggle() {
    const btn = document.createElement("button");
    btn.id = TOGGLE_ID;
    btn.type = "button";
    btn.textContent = "通知管理";
    btn.title = "管理哪些群组需要通知";
    btn.addEventListener("click", () => {
      const panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      panel.classList.toggle("hidden");
      if (!panel.classList.contains("hidden")) renderPanel();
    });
    document.body.appendChild(btn);
  }

  function injectPanelShell() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "hidden";
    panel.innerHTML = `
      <div class="tn-header">
        <h2>Teams 通知管理</h2>
        <button type="button" class="tn-close" aria-label="关闭">×</button>
      </div>
      <label class="tn-enabled-row">
        <input type="checkbox" id="tn-enabled" />
        <span>启用通知过滤</span>
      </label>
      <div class="tn-body" id="tn-body"></div>
    `;
    panel.querySelector(".tn-close")?.addEventListener("click", () => panel.classList.add("hidden"));
    document.body.appendChild(panel);
    panel.querySelector("#tn-enabled")?.addEventListener("change", async (e) => {
      await saveConfig({ enabled: e.target.checked });
    });
  }

  function normalizeConfig(raw) {
    return {
      enabled: raw?.enabled !== false,
      notifyThreadIds: Array.isArray(raw?.notifyThreadIds) ? [...new Set(raw.notifyThreadIds)] : [],
      notifyThreadTitles: Array.isArray(raw?.notifyThreadTitles)
        ? [...new Set(raw.notifyThreadTitles)]
        : [],
      threadCatalog: raw?.threadCatalog && typeof raw.threadCatalog === "object" ? raw.threadCatalog : {},
    };
  }

  async function loadConfig() {
    const res = await sendMessage("GET_CONFIG");
    config = normalizeConfig(res.config);
    const enabledEl = document.getElementById("tn-enabled");
    if (enabledEl) enabledEl.checked = !!config.enabled;
  }

  async function saveConfig(partial) {
    const res = await sendMessage("SAVE_CONFIG", { config: partial });
    config = normalizeConfig(res.config);
    renderPanel();
    const threads = window.TeamsNotifyUtils?.collectAllThreadsAsync
      ? await window.TeamsNotifyUtils.collectAllThreadsAsync(config.threadCatalog, { scrollList: false })
      : window.TeamsNotifyUtils?.collectAllThreads?.(config.threadCatalog) || [];
    await sendMessage("TEAMS_SYNC_CATALOG", { threads });
    lastCatalogSyncAt = Date.now();
  }

  function scheduleCatalogSync(threads) {
    const now = Date.now();
    if (now - lastCatalogSyncAt < 30000) return;
    clearTimeout(catalogSyncTimer);
    catalogSyncTimer = setTimeout(() => {
      lastCatalogSyncAt = Date.now();
      sendMessage("TEAMS_SYNC_CATALOG", { threads }).catch(() => {});
    }, 800);
  }

  function renderItem(thread, zone) {
    const item = document.createElement("div");
    item.className = `tn-item${thread.chatType === "private" ? " private" : ""}`;
    item.dataset.threadId = thread.id;

    if (thread.chatType !== "private") {
      item.draggable = true;
      item.addEventListener("dragstart", () => {
        dragThreadId = thread.id;
        dragThreadTitle = thread.title;
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => {
        dragThreadId = null;
        dragThreadTitle = "";
        item.classList.remove("dragging");
      });
    }

    const title = document.createElement("div");
    title.className = "tn-item-title";
    title.textContent = thread.title;
    title.title = thread.title;

    const badge = document.createElement("span");
    badge.className = `tn-badge${thread.chatType === "private" ? " private" : ""}`;
    badge.textContent = thread.chatType === "private" ? "私人·始终通知" : "群组";

    item.appendChild(title);
    item.appendChild(badge);

    if (thread.unreadCount > 0) {
      const unread = document.createElement("span");
      unread.className = "tn-badge unread";
      unread.textContent = `${thread.unreadCount} 未读`;
      item.appendChild(unread);
    }

    if (thread.chatType !== "private") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tn-btn secondary";
      if (zone === "notify") {
        btn.textContent = "移出";
        btn.addEventListener("click", () => moveThread(thread.id, "silent", thread.title));
      } else {
        btn.textContent = "移入通知";
        btn.addEventListener("click", () => moveThread(thread.id, "notify", thread.title));
      }
      item.appendChild(btn);
    }

    return item;
  }

  function bindDropZone(el, zone) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drag-over");
      if (!dragThreadId) return;
      await moveThread(dragThreadId, zone, dragThreadTitle);
      dragThreadId = null;
      dragThreadTitle = "";
    });
  }

  async function moveThread(threadId, zone, title) {
    const ids = new Set(config.notifyThreadIds || []);
    const titles = new Set(config.notifyThreadTitles || []);
    const titleKey = window.TeamsNotifyUtils?.normalizeTitleKey?.(title) || "";
    if (zone === "notify") {
      ids.add(threadId);
      if (titleKey) titles.add(titleKey);
    } else {
      ids.delete(threadId);
      if (titleKey) titles.delete(titleKey);
    }
    await saveConfig({ notifyThreadIds: [...ids], notifyThreadTitles: [...titles] });
  }

  async function renderPanel() {
    const body = document.getElementById("tn-body");
    if (!body || !window.TeamsNotifyUtils) return;

    body.innerHTML = `<div class="tn-empty">正在加载会话列表…</div>`;

    const threads = await window.TeamsNotifyUtils.collectAllThreadsAsync(config.threadCatalog, {
      scrollList: true,
      forceIdb: true,
    });
    scheduleCatalogSync(threads);

    const notifySet = new Set(config.notifyThreadIds || []);
    const notifyTitleSet = new Set(config.notifyThreadTitles || []);
    const privates = threads.filter((t) => t.chatType === "private");
    const notifyGroups = threads.filter(
      (t) =>
        t.chatType === "group" &&
        (notifySet.has(t.id) || notifyTitleSet.has(window.TeamsNotifyUtils.normalizeTitleKey(t.title)))
    );
    const silentGroups = threads.filter(
      (t) =>
        t.chatType === "group" &&
        !notifySet.has(t.id) &&
        !notifyTitleSet.has(window.TeamsNotifyUtils.normalizeTitleKey(t.title))
    );

    body.innerHTML = "";

    const privateSection = document.createElement("section");
    privateSection.className = "tn-section";
    privateSection.innerHTML = `<p class="tn-section-title">私人消息（始终通知）</p><p class="tn-hint">私聊无法移出，有新消息一定会提醒。</p>`;
    const privateList = document.createElement("div");
    privateList.className = "tn-list";
    if (!privates.length) {
      privateList.innerHTML = `<div class="tn-empty">暂未识别到私聊会话</div>`;
    } else {
      privates.forEach((t) => privateList.appendChild(renderItem(t, "private")));
    }
    privateSection.appendChild(privateList);
    body.appendChild(privateSection);

    const notifySection = document.createElement("section");
    notifySection.className = "tn-section";
    notifySection.innerHTML = `<p class="tn-section-title">🔔 通知文件夹</p><p class="tn-hint">拖入或点击「移入通知」，这些群组有新消息会提醒。</p>`;
    const notifyList = document.createElement("div");
    notifyList.className = "tn-list notify-zone";
    bindDropZone(notifyList, "notify");
    if (!notifyGroups.length) {
      notifyList.innerHTML = `<div class="tn-empty">把需要通知的群组移到这里</div>`;
    } else {
      notifyGroups.forEach((t) => notifyList.appendChild(renderItem(t, "notify")));
    }
    notifySection.appendChild(notifyList);
    body.appendChild(notifySection);

    const silentSection = document.createElement("section");
    silentSection.className = "tn-section";
    silentSection.innerHTML = `<p class="tn-section-title">🔕 其他群组（不通知）</p>`;
    const search = document.createElement("input");
    search.className = "tn-search";
    search.placeholder = "搜索群组…";
    silentSection.appendChild(search);
    const silentList = document.createElement("div");
    silentList.className = "tn-list silent-zone";
    bindDropZone(silentList, "silent");

    function paintSilent(filter) {
      silentList.innerHTML = "";
      const q = String(filter || "").trim().toLowerCase();
      const list = silentGroups.filter((t) => !q || t.title.toLowerCase().includes(q));
      if (!list.length) {
        silentList.innerHTML = `<div class="tn-empty">${q ? "没有匹配的群组" : "所有群组已在通知文件夹，或未识别到群组"}</div>`;
        return;
      }
      list.forEach((t) => silentList.appendChild(renderItem(t, "silent")));
    }

    search.addEventListener("input", () => paintSilent(search.value));
    paintSilent("");
    silentSection.appendChild(silentList);
    body.appendChild(silentSection);

    const enabledEl = document.getElementById("tn-enabled");
    if (enabledEl) enabledEl.checked = !!config.enabled;
  }

  function sendMessage(type, payload = {}) {
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
})();

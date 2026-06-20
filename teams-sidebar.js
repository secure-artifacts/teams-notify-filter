(function () {
  const SIDEBAR_ID = "teams-notify-sidebar";
  let config = {
    enabled: true,
    notifyThreadIds: [],
    notifyThreadTitles: [],
    manualThreads: [],
    threadCatalog: {},
  };
  let dragThreadId = null;
  let dragThreadTitle = "";
  let collapsed = false;
  let searchQuery = "";
  let lastThreadsKey = "";
  let renderTimer = null;
  let catalogSyncTimer = null;
  let cachedThreads = [];

  initSidebar().catch((err) => console.warn("[teams-notify] sidebar", err));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.config) return;
    const prev = config;
    const next = normalizeConfig(changes.config.newValue);
    const catalogOnly =
      JSON.stringify(prev.notifyThreadIds) === JSON.stringify(next.notifyThreadIds) &&
      JSON.stringify(prev.notifyThreadTitles) === JSON.stringify(next.notifyThreadTitles) &&
      JSON.stringify(prev.manualThreads) === JSON.stringify(next.manualThreads) &&
      prev.enabled === next.enabled;
    config = next;
    if (catalogOnly) return;
    scheduleRender();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TEAMS_SIDEBAR_REFRESH" || message?.type === "TEAMS_PANEL_REFRESH") {
      refreshAndRender(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  function stopTeamsCapture(el) {
    const stop = (e) => e.stopPropagation();
    el.addEventListener("mousedown", stop, true);
    el.addEventListener("mouseup", stop, true);
    el.addEventListener("click", stop, true);
    el.addEventListener("pointerdown", stop, true);
    el.addEventListener("keydown", stop, true);
    el.addEventListener("keyup", stop, true);
    el.addEventListener("focusin", stop, true);
  }

  async function initSidebar() {
    if (document.getElementById(SIDEBAR_ID)) return;
    injectShell();
    await loadConfig();
    await refreshAndRender(true);
    setInterval(() => {
      if (document.getElementById(SIDEBAR_ID)?.classList.contains("collapsed")) return;
      if (document.activeElement?.id === "tn-group-search") return;
      refreshAndRender(false).catch(() => {});
    }, 30000);
  }

  function injectShell() {
    const el = document.createElement("aside");
    el.id = SIDEBAR_ID;
    el.innerHTML = `
      <div class="tn-sidebar-head">
        <span class="tn-sidebar-head-title">Teams 通知</span>
        <button type="button" class="tn-collapse-btn" id="tn-collapse" title="收起/展开">⟩</button>
      </div>
      <div class="tn-sidebar-actions">
        <button type="button" class="tn-btn secondary" id="tn-refresh">刷新列表</button>
        <button type="button" class="tn-btn secondary" id="tn-add-current">添加当前聊天</button>
      </div>
      <label class="tn-enabled-row">
        <input type="checkbox" id="tn-enabled" />
        <span>启用通知过滤</span>
      </label>
      <p class="tn-status-line" id="tn-status-line">加载中…</p>
      <div class="tn-search-wrap">
        <input type="text" id="tn-group-search" class="tn-search" placeholder="搜索群组…" autocomplete="off" />
      </div>
      <div class="tn-sidebar-main" id="tn-sidebar-body"></div>
    `;
    document.body.appendChild(el);
    stopTeamsCapture(el);

    const search = el.querySelector("#tn-group-search");
    search?.addEventListener("input", () => {
      searchQuery = search.value;
      paintAllGroups();
    });
    search?.addEventListener("mousedown", (e) => e.stopPropagation());
    search?.addEventListener("click", (e) => {
      e.stopPropagation();
      search.focus();
    });

    el.querySelector("#tn-collapse")?.addEventListener("click", () => {
      collapsed = !collapsed;
      el.classList.toggle("collapsed", collapsed);
      el.querySelector("#tn-collapse").textContent = collapsed ? "⟨" : "⟩";
    });
    el.querySelector("#tn-refresh")?.addEventListener("click", () => refreshAndRender(true));
    el.querySelector("#tn-add-current")?.addEventListener("click", () => addCurrentChat());
    el.querySelector("#tn-enabled")?.addEventListener("change", (e) =>
      saveConfig({ enabled: e.target.checked }, false)
    );
  }

  function normalizeConfig(raw) {
    return {
      enabled: raw?.enabled !== false,
      notifyThreadIds: Array.isArray(raw?.notifyThreadIds) ? [...new Set(raw.notifyThreadIds)] : [],
      notifyThreadTitles: Array.isArray(raw?.notifyThreadTitles)
        ? [...new Set(raw.notifyThreadTitles)]
        : [],
      manualThreads: Array.isArray(raw?.manualThreads) ? raw.manualThreads : [],
      threadCatalog: raw?.threadCatalog && typeof raw.threadCatalog === "object" ? raw.threadCatalog : {},
    };
  }

  async function loadConfig() {
    const res = await sendMessage("GET_CONFIG");
    config = normalizeConfig(res.config);
    const enabledEl = document.getElementById("tn-enabled");
    if (enabledEl) enabledEl.checked = !!config.enabled;
  }

  async function saveConfig(partial, refresh = true) {
    const res = await sendMessage("SAVE_CONFIG", { config: partial });
    config = normalizeConfig(res.config);
    if (refresh) await refreshAndRender(true);
    else scheduleRender();
  }

  async function addCurrentChat() {
    const current = window.TeamsNotifyNav?.readCurrentConversationMeta?.();
    if (!current?.id) {
      setStatus("请先在左侧 Teams 里点开一个聊天，再点「添加当前聊天」");
      return;
    }
    const manual = [...(config.manualThreads || [])];
    if (!manual.some((t) => t.id === current.id)) manual.push(current);
    await saveConfig({ manualThreads: manual }, true);
    setStatus(`已添加：${current.title}`);
  }

  function scheduleRender() {
    if (document.activeElement?.id === "tn-group-search") {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => scheduleRender(), 500);
      return;
    }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderSidebar(), 80);
  }

  function scheduleCatalogSync(threads) {
    clearTimeout(catalogSyncTimer);
    catalogSyncTimer = setTimeout(() => {
      sendMessage("TEAMS_SYNC_CATALOG", { threads }).catch(() => {});
    }, 2000);
  }

  async function refreshAndRender(force) {
    if (window.TeamsNotifyIdb?.refreshIdbThreads) {
      await window.TeamsNotifyIdb.refreshIdbThreads(!!force);
    }
    if (window.TeamsNotifyUtils?.collectAllThreadsAsync) {
      await window.TeamsNotifyUtils.collectAllThreadsAsync(config.threadCatalog, {
        scrollList: !!force,
        forceIdb: !!force,
      });
    }
    await renderSidebar(true);
  }

  function mergeManualThreads(threads) {
    const map = new Map(threads.map((t) => [t.id, t]));
    for (const t of config.manualThreads || []) {
      if (!t?.id) continue;
      if (!map.has(t.id)) map.set(t.id, t);
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  function getThreads() {
    let threads = window.TeamsNotifyUtils?.collectAllThreads?.(config.threadCatalog) || [];
    return mergeManualThreads(threads);
  }

  async function renderSidebar(syncCatalog) {
    const body = document.getElementById("tn-sidebar-body");
    if (!body || !window.TeamsNotifyUtils) return;

    cachedThreads = getThreads();
    const threadsKey = cachedThreads.map((t) => t.id).join("|");
    if (threadsKey === lastThreadsKey && body.childElementCount > 0 && !syncCatalog) {
      paintAllGroups();
      return;
    }
    lastThreadsKey = threadsKey;

    if (syncCatalog) scheduleCatalogSync(cachedThreads);

    setStatus(
      `共 ${cachedThreads.length} 个会话（群组 ${cachedThreads.filter((t) => t.chatType === "group").length}）`
    );

    const notifySet = new Set(config.notifyThreadIds || []);
    const notifyTitleSet = new Set(config.notifyThreadTitles || []);
    const norm = window.TeamsNotifyUtils.normalizeTitleKey;

    const privates = cachedThreads.filter((t) => t.chatType === "private");
    const groups = cachedThreads.filter((t) => t.chatType === "group");
    const notifyGroups = groups.filter(
      (t) => notifySet.has(t.id) || notifyTitleSet.has(norm(t.title))
    );

    body.innerHTML = "";

    body.appendChild(
      buildSection("私人消息（始终通知）", "私聊始终会提醒。", privates, "private", notifySet, notifyTitleSet)
    );

    const notifySection = buildSection(
      "🔔 通知文件夹",
      "这些群组有新消息会提醒。",
      notifyGroups,
      "notify",
      notifySet,
      notifyTitleSet
    );
    bindDropZone(notifySection.querySelector(".notify-zone"), "notify");
    body.appendChild(notifySection);

    const allSection = document.createElement("section");
    allSection.className = "tn-section";
    allSection.innerHTML = `<p class="tn-section-title">💬 所有群组（点击名称打开聊天）</p>`;
    const allList = document.createElement("div");
    allList.id = "tn-all-groups-list";
    allList.className = "tn-list all-zone";
    bindDropZone(allList, "silent");
    allSection.appendChild(allList);
    body.appendChild(allSection);

    const searchEl = document.getElementById("tn-group-search");
    if (searchEl && searchEl.value !== searchQuery) searchEl.value = searchQuery;

    paintAllGroups();

    const enabledEl = document.getElementById("tn-enabled");
    if (enabledEl) enabledEl.checked = !!config.enabled;
  }

  function paintAllGroups() {
    const allList = document.getElementById("tn-all-groups-list");
    if (!allList) return;

    const notifySet = new Set(config.notifyThreadIds || []);
    const notifyTitleSet = new Set(config.notifyThreadTitles || []);
    const norm = window.TeamsNotifyUtils.normalizeTitleKey;
    const groups = cachedThreads.filter((t) => t.chatType === "group");
    const silentGroups = groups.filter(
      (t) => !notifySet.has(t.id) && !notifyTitleSet.has(norm(t.title))
    );

    const query = String(searchQuery || "").trim().toLowerCase();
    const list = silentGroups.filter((t) => !query || t.title.toLowerCase().includes(query));

    allList.innerHTML = "";
    if (!list.length) {
      allList.innerHTML = `<div class="tn-empty">${query ? "没有匹配" : "暂无群组，请点「添加当前聊天」或刷新"}</div>`;
      return;
    }
    list.forEach((t) => allList.appendChild(renderItem(t, notifySet, notifyTitleSet)));
  }

  function buildSection(title, hint, threads, zone, notifySet, notifyTitleSet) {
    const section = document.createElement("section");
    section.className = "tn-section";
    section.innerHTML = `<p class="tn-section-title">${title}</p><p class="tn-hint">${hint}</p>`;
    const list = document.createElement("div");
    list.className = `tn-list${zone === "notify" ? " notify-zone" : ""}`;
    if (!threads.length) {
      list.innerHTML = `<div class="tn-empty">暂无</div>`;
    } else {
      threads.forEach((t) => list.appendChild(renderItem(t, notifySet, notifyTitleSet)));
    }
    section.appendChild(list);
    return section;
  }

  function renderItem(thread, notifySet, notifyTitleSet) {
    const item = document.createElement("div");
    item.className = `tn-item${thread.chatType === "private" ? " private" : ""}`;

    if (thread.chatType !== "private") {
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        dragThreadId = thread.id;
        dragThreadTitle = thread.title;
      });
      item.addEventListener("dragend", () => {
        dragThreadId = null;
        dragThreadTitle = "";
      });
    }

    const title = document.createElement("div");
    title.className = "tn-item-title";
    title.textContent = thread.title;
    title.title = `打开：${thread.title}`;
    title.addEventListener("mousedown", (e) => e.stopPropagation());
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      window.TeamsNotifyNav?.openConversation?.(thread.id);
    });

    item.appendChild(title);

    if (thread.unreadCount > 0) {
      const unread = document.createElement("span");
      unread.className = "tn-badge unread";
      unread.textContent = String(thread.unreadCount);
      item.appendChild(unread);
    }

    if (thread.chatType !== "private") {
      const inNotify =
        notifySet.has(thread.id) ||
        notifyTitleSet.has(window.TeamsNotifyUtils.normalizeTitleKey(thread.title));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tn-btn secondary";
      btn.textContent = inNotify ? "移出" : "通知";
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveThread(thread.id, inNotify ? "silent" : "notify", thread.title);
      });
      item.appendChild(btn);
    }

    return item;
  }

  function bindDropZone(el, zone) {
    if (!el) return;
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
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
    await saveConfig({ notifyThreadIds: [...ids], notifyThreadTitles: [...titles] }, false);
  }

  function setStatus(text) {
    const el = document.getElementById("tn-status-line");
    if (el) el.textContent = text;
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

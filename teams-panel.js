/** Teams 通知设置面板（v5 简化版） */
(function () {
  if (window !== window.top) return;

  const PANEL_ID = "teams-notify-panel";
  const DEFAULT_CONFIG = {
    enabled: true,
    mode: "allow_list",
    keywords: [],
    threads: [],
    cacheInviteLinks: true,
  };

  const MODE_COPY = {
    allow_list: {
      threadListTitle: "允许通知的群组",
      threadEmpty: "未选群组时，所有群通知将被屏蔽，私信仍会提醒。",
      keywordHint: "可补充群名关键词。手动添加时建议填写群名，或添加后点「刷新群名」。",
    },
    block_list: {
      threadListTitle: "屏蔽的群组",
      threadEmpty: "未选群组时，不会按 ID 屏蔽任何群。",
      keywordHint: "可补充群名关键词。手动添加时建议填写群名，或添加后点「刷新群名」。",
    },
  };

  let config = { ...DEFAULT_CONFIG };
  let teamsGroups = [];
  let pickerQuery = "";
  let collapsed = true;
  let mounted = false;
  let loadedOnce = false;
  let pickerLimit = 60;

  init();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !mounted) return;
    if (!changes.enabled && !changes.mode && !changes.keywords && !changes.threads && !changes.blacklist && !changes.cacheInviteLinks) return;
    loadConfig().then(() => render());
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOGGLE_TEAMS_PANEL") {
      ensureMounted();
      collapsed = !collapsed;
      applyCollapsed();
      if (!collapsed) ensureLoadGroups();
      sendResponse({ ok: true, collapsed });
      return false;
    }
    return false;
  });

  async function init() {
    await loadConfig();
  }

  function ensureMounted() {
    if (mounted && document.getElementById(PANEL_ID)) return;
    if (!document.body) {
      setTimeout(ensureMounted, 300);
      return;
    }
    mountPanel();
    render();
    mounted = true;
  }

  function ensureLoadGroups() {
    if (loadedOnce) return;
    loadedOnce = true;
    loadGroups(true);
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.className = "teams-notify-panel collapsed";
    panel.innerHTML = `
      <header class="tn-head">
        <div class="tn-head-title">Teams 通知设置</div>
        <button type="button" class="tn-collapse" id="tn-collapse" title="收起">⟩</button>
      </header>
      <div class="tn-body" id="tn-body"></div>
      <button type="button" class="tn-expand-tab" id="tn-expand" title="展开设置">设置 ⟨</button>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#tn-collapse")?.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = true;
      applyCollapsed();
    });
    panel.querySelector("#tn-expand")?.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = false;
      applyCollapsed();
      ensureLoadGroups();
    });

    stopTeamsCapture(panel);
    applyCollapsed();
  }

  function applyCollapsed() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle("collapsed", collapsed);
    document.documentElement.classList.toggle("teams-notify-panel-open", !collapsed);
  }

  function stopTeamsCapture(el) {
    const stop = (e) => {
      if (e.target.closest("button, input, label, select, textarea, a")) return;
      e.stopPropagation();
    };
    el.addEventListener("mousedown", stop, true);
    el.addEventListener("click", stop, true);
  }

  function normalizeConfig(raw) {
    const legacyList = Array.isArray(raw?.blacklist) ? raw.blacklist : [];
    const keywords = Array.isArray(raw?.keywords) ? raw.keywords : legacyList;
    const threads = Array.isArray(raw?.threads) ? raw.threads : [];
    const threadMap = new Map();
    for (const item of threads) {
      const title = String(item?.title || "").trim();
      const id = String(item?.id || "").trim();
      if (!id && !title) continue;
      const safeTitle =
        title && !window.TeamsTitles?.isIdLikeTitle?.(title)
          ? title
          : id
            ? window.TeamsTitles?.UNNAMED || "未命名群组"
            : title;
      threadMap.set(id || `title:${title.toLowerCase()}`, { id, title: safeTitle, chatType: "group" });
    }
    return {
      enabled: raw?.enabled !== false,
      mode: raw?.mode === "block_list" ? "block_list" : "allow_list",
      keywords: [...new Set(keywords.map((item) => String(item || "").trim()).filter(Boolean))],
      threads: [...threadMap.values()],
      cacheInviteLinks: raw?.cacheInviteLinks !== false,
    };
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_CONFIG, (data) => {
        config = normalizeConfig(data || DEFAULT_CONFIG);
        resolve(config);
        void chrome.runtime.lastError;
      });
    });
  }

  function saveConfig(partial) {
    config = normalizeConfig({ ...config, ...partial });
    chrome.storage.sync.set(
      {
        enabled: config.enabled,
        mode: config.mode,
        keywords: config.keywords,
        threads: config.threads,
        cacheInviteLinks: config.cacheInviteLinks,
      },
      () => {
        render();
        void chrome.runtime.lastError;
      }
    );
  }

  function setStatus(text) {
    const el = document.getElementById("tn-status");
    if (el) el.textContent = text;
  }

  function clearLinkCache(options = {}) {
    chrome.storage.local.remove(["inviteResolveCache", "discoveredGroups"], () => {
      teamsGroups = teamsGroups.filter((g) => g.source !== "link" && g.source !== "invite");
      if (!options.silent) {
        setStatus("已清除本机链接/邀请缓存");
        loadGroups(true);
      }
      void chrome.runtime.lastError;
    });
  }

  async function loadGroups(force) {
    const btn = document.getElementById("tn-refresh-groups");
    if (btn) btn.disabled = true;
    setStatus("正在读取群组…");

    try {
      const api = window.TeamsGroups;
      if (!api?.collectGroupsAsync) throw new Error("模块未加载，请刷新页面");

      const result = await api.collectGroupsAsync(!!force);
      if (!result.ok) throw new Error(result.error || "读取失败");

      teamsGroups = result.groups || [];
      pickerLimit = 60;

      if (!teamsGroups.length) {
        setStatus(result.hint || "未读取到群组");
      } else {
        setStatus(
          `共 ${teamsGroups.length} 个（链接 ${result.fromLinks || 0} · 会议 ${result.meetings || 0} · 列表 ${result.fromDom} · 数据库 ${result.fromIdb}）${result.hint ? " · " + result.hint : ""}`
        );
      }
      renderPicker();
      refreshThreadTitles().catch(() => {});
    } catch (error) {
      teamsGroups = [];
      setStatus(error.message);
      renderPicker(error.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function normalizeThreadId(raw) {
    let id = String(raw || "").trim();
    if (/^meeting_/i.test(id) && !id.startsWith("19:")) id = `19:${id}`;
    if (id.startsWith("19:") && !id.includes("@thread")) {
      const candidate = `${id}@thread.v2`;
      if (window.TeamsTitles?.isThreadId?.(candidate)) return candidate;
    }
    return id;
  }

  function isMissingThreadTitle(thread) {
    const title = String(thread?.title || "").trim();
    const id = String(thread?.id || "").trim();
    const unnamed = window.TeamsTitles?.UNNAMED || "未命名群组";
    if (!title) return true;
    if (title === id) return true;
    if (title === unnamed) return true;
    return window.TeamsTitles?.isIdLikeTitle?.(title);
  }

  function displayThreadTitle(title, id) {
    const text = String(title || "").trim();
    if (text && !window.TeamsTitles?.isIdLikeTitle?.(text)) return text;
    return window.TeamsTitles?.UNNAMED || "未命名群组";
  }

  async function resolveTitleForId(id, manualTitle) {
    const manual = String(manualTitle || "").trim();
    if (manual && !window.TeamsTitles?.isIdLikeTitle?.(manual)) return manual;

    const hit = teamsGroups.find((g) => g.id === id);
    if (hit?.title && !window.TeamsTitles?.isIdLikeTitle?.(hit.title)) return hit.title;

    const api = window.TeamsGroups;
    if (api?.lookupGroupById) {
      const found = await api.lookupGroupById(id);
      if (found?.title && !window.TeamsTitles?.isIdLikeTitle?.(found.title)) return found.title;
    }

    return window.TeamsTitles?.UNNAMED || "未命名群组";
  }

  async function refreshThreadTitles() {
    const btn = document.getElementById("tn-refresh-titles");
    if (btn) btn.disabled = true;
    setStatus("正在刷新群名…");

    let updated = 0;
    const threads = [...config.threads];
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      if (!thread.id || !isMissingThreadTitle(thread)) continue;
      const title = await resolveTitleForId(thread.id, "");
      if (title && !window.TeamsTitles?.isIdLikeTitle?.(title) && title !== thread.title) {
        threads[i] = { ...thread, title };
        updated += 1;
      }
    }

    if (updated > 0) {
      saveConfig({ threads });
      setStatus(`已更新 ${updated} 个群名`);
    } else {
      setStatus("未识别到新群名。请先在 Teams 打开该群聊天，再点「刷新群名」");
    }

    if (btn) btn.disabled = false;
  }

  function addKeyword(value) {
    const text = String(value || "").trim();
    if (!text) return;
    if (config.keywords.some((k) => k.toLowerCase() === text.toLowerCase())) return;
    saveConfig({ keywords: [...config.keywords, text] });
    setStatus("已添加关键词");
  }

  function addThread(thread) {
    if (!thread?.id && !thread?.title) return;
    const exists = config.threads.some(
      (item) => (thread.id && item.id === thread.id) || (thread.title && item.title === thread.title)
    );
    if (exists) {
      setStatus("已在列表中");
      return;
    }
    saveConfig({
      threads: [
        ...config.threads,
        {
          id: thread.id || "",
          title: displayThreadTitle(thread.title, thread.id),
          chatType: "group",
        },
      ],
    });
    setStatus(`已添加：${displayThreadTitle(thread.title, thread.id)}`);
  }

  async function openGroupChat(group) {
    const id = String(group?.id || "").trim();
    const title = String(group?.title || "").trim();
    if (!id && !title) {
      setStatus("无法打开：缺少群组信息");
      return;
    }

    setStatus(`正在打开：${title || shortId(id)}…`);
    const nav = window.TeamsNav;
    if (!nav?.openConversation) {
      setStatus("导航模块未加载，请刷新 Teams 页面");
      return;
    }

    const result = await nav.openConversation({ id, title });
    if (result?.ok) {
      if (result.method === "current") {
        setStatus(`已在聊天：${title || shortId(id)}`);
      } else {
        setStatus(`正在打开：${title || shortId(id)}…`);
      }
      return;
    }
    setStatus(`无法打开「${title || shortId(id)}」：缺少有效群组 ID`);
  }

  async function openInviteLinkInWeb(raw) {
    const input = String(raw || "").trim();
    const inviteUrl =
      window.TeamsInvite?.normalizeInviteUrl?.(input) ||
      (/^https?:\/\/teams\.(live|microsoft)\.com\/l\/invite\//i.test(input) ? input : "");
    if (!inviteUrl) {
      setStatus("请先粘贴 /l/invite/ 邀请链接");
      return;
    }
    setStatus("正在打开邀请页…若弹出桌面版请点「取消」");
    window.TeamsInvite?.openInviteInWeb?.(inviteUrl);
  }

  async function addThreadById(raw, manualTitle) {
    const input = String(raw || "").trim();
    const inviteUrl =
      window.TeamsInvite?.normalizeInviteUrl?.(input) ||
      (/^https?:\/\/teams\.(live|microsoft)\.com\/l\/invite\//i.test(input) ? input : "");

    const btn = document.getElementById("tn-add-id");
    if (btn) btn.disabled = true;

    if (inviteUrl) {
      setStatus("正在解析邀请链接…");
      try {
        const resolved = await window.TeamsInvite?.resolveInviteUrl?.(inviteUrl, manualTitle);
        if (resolved?.chatId) {
          const title = await resolveTitleForId(resolved.chatId, manualTitle || resolved.title);
          addThread({ id: resolved.chatId, title });
          setStatus(`已添加：${displayThreadTitle(title, resolved.chatId)}`);
          return;
        }
        await window.TeamsLinkGroups?.openInviteUrl?.(inviteUrl, manualTitle);
        setStatus("无法自动解析。可点「用链接打开」在网页完成（无需群名）");
      } finally {
        if (btn) btn.disabled = false;
      }
      return;
    }

    const id = normalizeThreadId(input);

    if (!window.TeamsTitles?.isThreadId?.(id)) {
      setStatus("无效：支持 19:...@thread.v2、meeting_… 或 /l/invite/ 链接");
      if (btn) btn.disabled = false;
      return;
    }

    setStatus("正在解析群名…");

    try {
      const title = await resolveTitleForId(id, manualTitle);
      addThread({ id, title });
      if (
        window.TeamsTitles?.isIdLikeTitle?.(title) ||
        title === (window.TeamsTitles?.UNNAMED || "未命名群组")
      ) {
        setStatus("已添加。未识别到群名：可先打开该群聊天，再点「刷新群名」");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderPicker(errorMessage) {
    const pickerList = document.getElementById("tn-picker-list");
    const pickerEmpty = document.getElementById("tn-picker-empty");
    const pickerMore = document.getElementById("tn-picker-more");
    if (!pickerList || !pickerEmpty) return;

    const q = pickerQuery.trim().toLowerCase();
    const filtered = teamsGroups.filter((g) => !q || g.title.toLowerCase().includes(q) || g.id.includes(q));
    const visible = filtered.slice(0, pickerLimit);

    pickerList.innerHTML = "";
    for (const group of visible) {
      const already = config.threads.some((item) => item.id && item.id === group.id);
      const li = document.createElement("li");
      li.className = "tn-picker-item tn-picker-open";
      li.title = "点击打开聊天";
      li.innerHTML = `
        <div class="tn-picker-meta tn-openable">
          <div class="tn-picker-title" title="${escapeAttr(group.title)}">${escapeHtml(group.title)}${group.source === "link" ? ' <span class="tn-tag">链接</span>' : ""}</div>
          <div class="tn-picker-id" title="${escapeAttr(group.id)}">${escapeHtml(shortId(group.id))}</div>
        </div>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        e.stopPropagation();
        openGroupChat(group);
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tn-btn small${already ? " disabled" : " primary"}`;
      btn.textContent = already ? "已添加" : "添加";
      btn.disabled = already;
      btn.addEventListener("click", () => addThread(group));
      li.appendChild(btn);
      pickerList.appendChild(li);
    }

    if (pickerMore) {
      const rest = filtered.length - visible.length;
      pickerMore.classList.toggle("hidden", rest <= 0);
      pickerMore.textContent = rest > 0 ? `还有 ${rest} 个，点击加载更多` : "";
    }

    pickerEmpty.classList.toggle("hidden", filtered.length > 0);
    pickerEmpty.classList.toggle("error", !!errorMessage);
    pickerEmpty.textContent =
      errorMessage || (loadedOnce ? "没有匹配的群组，试试搜索或手动粘贴 ID" : "展开面板后将自动读取");
  }

  function render() {
    const body = document.getElementById("tn-body");
    if (!body) return;

    const copy = MODE_COPY[config.mode] || MODE_COPY.allow_list;

    body.innerHTML = `
      <label class="tn-row">
        <input type="checkbox" id="tn-enabled" ${config.enabled ? "checked" : ""} />
        <span>启用通知过滤</span>
      </label>
      <p class="tn-status" id="tn-status">点击展开后自动读取群组</p>

      <section class="tn-card">
        <p class="tn-label">工作模式</p>
        <label class="tn-mode">
          <input type="radio" name="tn-mode" value="allow_list" ${config.mode === "allow_list" ? "checked" : ""} />
          <span><strong>默认屏蔽群组</strong><small>只提醒下方列表中的群，私信始终放行</small></span>
        </label>
        <label class="tn-mode">
          <input type="radio" name="tn-mode" value="block_list" ${config.mode === "block_list" ? "checked" : ""} />
          <span><strong>只屏蔽列表中的群</strong><small>其余群和私信正常提醒</small></span>
        </label>
      </section>

      <section class="tn-card">
        <div class="tn-list-head">
          <p class="tn-label">${escapeHtml(copy.threadListTitle)}</p>
          <div class="tn-list-actions">
            <button type="button" class="tn-btn secondary small" id="tn-refresh-titles">刷新群名</button>
            <span class="tn-badge">${config.threads.length}</span>
          </div>
        </div>
        <ul class="tn-list" id="tn-thread-list"></ul>
        <p class="tn-empty ${config.threads.length ? "hidden" : ""}">${escapeHtml(copy.threadEmpty)}</p>
      </section>

      <section class="tn-card">
        <div class="tn-list-head">
          <p class="tn-label">选择群组</p>
          <button type="button" class="tn-btn secondary small" id="tn-refresh-groups">重新读取</button>
        </div>
        <p class="tn-hint">点击聊天里的群组链接或邀请链接（/l/invite/）会自动打开。列表也可直接打开或添加。</p>
        <input type="search" class="tn-search" id="tn-picker-search" placeholder="搜索群名…" value="${escapeAttr(pickerQuery)}" />
        <ul class="tn-list tn-picker-list" id="tn-picker-list"></ul>
        <p class="tn-empty tn-picker-more" id="tn-picker-more"></p>
        <p class="tn-empty" id="tn-picker-empty">展开面板后将自动读取</p>
      </section>

      <section class="tn-card">
        <p class="tn-label">手动添加群组</p>
        <input type="text" class="tn-full-input" id="tn-title-input" placeholder="群名（推荐填写，或留空自动识别）" />
        <div class="tn-input-row">
          <input type="text" id="tn-id-input" placeholder="群组 ID 或 /l/invite/ 链接" />
          <button type="button" class="tn-btn primary small" id="tn-add-id">添加</button>
        </div>
        <div class="tn-input-row tn-privacy-actions">
          <button type="button" class="tn-btn secondary small" id="tn-open-invite-web">用链接打开（无需群名）</button>
        </div>
        <p class="tn-hint">只有邀请链接时：粘贴到上方输入框，点「用链接打开」。若弹出 ms-teams 请点「取消」，网页会自动加入并跳转。</p>
        <p class="tn-hint">群名最重要。只填 ID 时会自动从 Teams 读取；读不到显示「未命名群组」，打开该群后点「刷新群名」。</p>
        <p class="tn-hint">${escapeHtml(copy.keywordHint)}</p>
        <div class="tn-input-row">
          <input type="text" id="tn-keyword-input" placeholder="群名关键词" />
          <button type="button" class="tn-btn secondary small" id="tn-add-keyword">添加</button>
        </div>
        <ul class="tn-list" id="tn-keyword-list"></ul>
      </section>

      <section class="tn-card">
        <p class="tn-label">链接与隐私</p>
        <label class="tn-row">
          <input type="checkbox" id="tn-no-invite-cache" ${config.cacheInviteLinks ? "" : "checked"} />
          <span>不缓存邀请链接（不保存完整 /l/invite/ URL）</span>
        </label>
        <p class="tn-hint">开启后仍可在当前会话解析并打开群组，但不会写入本机缓存。</p>
        <div class="tn-input-row tn-privacy-actions">
          <button type="button" class="tn-btn secondary small" id="tn-clear-link-cache">清除链接缓存</button>
        </div>
        <p class="tn-hint">清除本机已存的邀请链接映射与从链接发现的群组列表，不上传任何数据。</p>
      </section>
    `;

    body.querySelector("#tn-enabled")?.addEventListener("change", (e) => saveConfig({ enabled: e.target.checked }));
    for (const input of body.querySelectorAll('input[name="tn-mode"]')) {
      input.addEventListener("change", () => {
        if (input.checked) saveConfig({ mode: input.value });
      });
    }
    body.querySelector("#tn-refresh-titles")?.addEventListener("click", () => refreshThreadTitles());
    body.querySelector("#tn-refresh-groups")?.addEventListener("click", () => loadGroups(true));
    body.querySelector("#tn-picker-search")?.addEventListener("input", (e) => {
      pickerQuery = e.target.value;
      pickerLimit = 60;
      renderPicker();
    });
    body.querySelector("#tn-picker-more")?.addEventListener("click", () => {
      pickerLimit += 60;
      renderPicker();
    });
    body.querySelector("#tn-open-invite-web")?.addEventListener("click", () => {
      openInviteLinkInWeb(body.querySelector("#tn-id-input")?.value);
    });
    body.querySelector("#tn-add-id")?.addEventListener("click", () => {
      addThreadById(body.querySelector("#tn-id-input")?.value, body.querySelector("#tn-title-input")?.value);
      const idInput = body.querySelector("#tn-id-input");
      const titleInput = body.querySelector("#tn-title-input");
      if (idInput) idInput.value = "";
      if (titleInput) titleInput.value = "";
    });
    body.querySelector("#tn-add-keyword")?.addEventListener("click", () => {
      addKeyword(body.querySelector("#tn-keyword-input")?.value);
      const input = body.querySelector("#tn-keyword-input");
      if (input) input.value = "";
    });
    body.querySelector("#tn-no-invite-cache")?.addEventListener("change", (e) => {
      const cacheInviteLinks = !e.target.checked;
      saveConfig({ cacheInviteLinks });
      if (!cacheInviteLinks) clearLinkCache({ silent: true });
      setStatus(cacheInviteLinks ? "已允许缓存邀请链接（仅本机）" : "已关闭邀请链接缓存，并清除已有缓存");
    });
    body.querySelector("#tn-clear-link-cache")?.addEventListener("click", () => clearLinkCache());

    const threadList = body.querySelector("#tn-thread-list");
    for (const thread of config.threads) {
      const li = document.createElement("li");
      li.className = "tn-list-item";
      li.innerHTML = `
        <div class="tn-item-meta${thread.id ? " tn-openable" : ""}" title="${thread.id ? "点击打开聊天" : ""}">
          <div class="tn-item-title" title="${escapeAttr(thread.title)}">${escapeHtml(displayThreadTitle(thread.title, thread.id))}</div>
          <div class="tn-item-id" title="${escapeAttr(thread.id)}">${escapeHtml(shortId(thread.id))}</div>
        </div>
      `;
      if (thread.id) {
        li.querySelector(".tn-item-meta")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openGroupChat(thread);
        });
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tn-btn ghost small";
      removeBtn.textContent = "删除";
      removeBtn.addEventListener("click", () => {
        saveConfig({ threads: config.threads.filter((t) => t !== thread) });
      });
      li.appendChild(removeBtn);
      threadList?.appendChild(li);
    }

    const keywordList = body.querySelector("#tn-keyword-list");
    for (const keyword of config.keywords) {
      const li = document.createElement("li");
      li.className = "tn-list-item";
      li.innerHTML = `<span class="tn-item-title">${escapeHtml(keyword)}</span>`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tn-btn ghost small";
      removeBtn.textContent = "删除";
      removeBtn.addEventListener("click", () => {
        saveConfig({ keywords: config.keywords.filter((k) => k !== keyword) });
      });
      li.appendChild(removeBtn);
      keywordList?.appendChild(li);
    }

    renderPicker();
  }

  function shortId(id) {
    const text = String(id || "");
    if (!text.includes("@")) return text || "无 ID";
    return text.length <= 30 ? text : `${text.slice(0, 14)}…${text.slice(-10)}`;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, "&quot;");
  }
})();

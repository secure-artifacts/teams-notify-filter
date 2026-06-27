/** Teams 网页内导航（统一入口，优先 SPA 切换，避免整页刷新） */
(function () {
  const NAV_EVENT = "teams-filter-navigate";
  const OPEN_CHAT_EVENT = "teams-filter-open-chat";
  const NAV_KEY_PATTERNS = [
    /^tmp\.session\.(.+)-mainWindowNavHistory$/,
    /^live\.session\.(.+)-mainWindowNavHistory$/,
    /^session\.(.+)-mainWindowNavHistory$/,
  ];

  function rootWindow() {
    try {
      return window.top || window;
    } catch {
      return window;
    }
  }

  function rootOrigin() {
    const root = rootWindow();
    const host = root.location.hostname || location.hostname;
    if (/teams\.live\.com/i.test(host)) return "https://teams.live.com";
    if (/teams\.microsoft\.com/i.test(host)) return "https://teams.microsoft.com";
    return root.location.origin || location.origin;
  }

  function isLiveSite() {
    return /teams\.live\.com/i.test(rootOrigin());
  }

  function isThreadId(id) {
    return window.TeamsTitles?.isThreadId?.(id) ?? /^19:/.test(String(id || ""));
  }

  function urlHasId(win, id) {
    const needle = String(id || "").trim();
    if (!needle) return false;
    try {
      return decodeURIComponent(win.location.href).includes(needle);
    } catch {
      return win.location.href.includes(needle);
    }
  }

  function updateSessionNav(id) {
    const root = rootWindow();
    try {
      const storage = root.sessionStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || !NAV_KEY_PATTERNS.some((pattern) => pattern.test(key))) continue;
        let data;
        try {
          data = JSON.parse(storage.getItem(key) || "{}");
        } catch {
          data = {};
        }
        if (!data.activeEntities || typeof data.activeEntities !== "object") data.activeEntities = {};
        data.activeEntities.mainEntity = {
          action: "view",
          id,
          entityType: "Conversation",
          type: "Conversation",
        };
        storage.setItem(key, JSON.stringify(data));
      }
    } catch {
      /* ignore */
    }
  }

  function buildWebTargets(id) {
    const origin = rootOrigin();
    const enc = encodeURIComponent(id);
    const targets = [];
    if (isLiveSite()) {
      targets.push(`${origin}/v2/?clientexperience=t2&chatId=${enc}`);
      targets.push(`${origin}/v2/?clientexperience=tfl&chatId=${enc}`);
    }
    targets.push(`${origin}/v2/?chatId=${enc}`);
    targets.push(`${origin}/v2/?conversationId=${enc}`);
    return [...new Set(targets)];
  }

  function idInElement(el, id) {
    if (!(el instanceof Element)) return false;
    for (const node of [el, ...el.querySelectorAll("a[href], [href]")]) {
      const href = node.getAttribute?.("href") || "";
      if (!href) continue;
      try {
        if (decodeURIComponent(href).includes(id)) return true;
      } catch {
        if (href.includes(id)) return true;
      }
    }
    for (const attr of ["data-conversation-id", "data-thread-id", "data-chat-id", "data-id", "itemid"]) {
      if ((el.getAttribute?.(attr) || "").trim() === id) return true;
    }
    return false;
  }

  /**
   * 最可靠的「不刷新」切换：在真实聊天/活动列表里找到该群条目并点击，
   * 让 Teams 自己的路由完成 SPA 切换（已加入、且当前在列表里可见时有效）。
   */
  function clickListItem(root, id) {
    try {
      const doc = root.document;
      const items = doc.querySelectorAll(
        '[data-tid*="chat-list"] [role="treeitem"], [data-tid*="chat-list"] [role="listitem"], [role="treeitem"], [role="listitem"]'
      );
      for (const item of items) {
        if (!idInElement(item, id)) continue;
        const clickable =
          item.querySelector('a[href], [role="link"], button') || item;
        clickable.click?.();
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function hardNavigate(root, url) {
    try {
      root.location.assign(url);
    } catch {
      root.location.href = url;
    }
  }

  function openConversation(input) {
    const id = String(input?.id || input || "").trim();
    if (!id || !isThreadId(id)) {
      return { ok: false, reason: "missing-id" };
    }

    const root = rootWindow();
    if (urlHasId(root, id)) {
      updateSessionNav(id);
      return { ok: true, method: "current" };
    }

    const targets = buildWebTargets(id);
    // 先写入 Teams 内部导航状态：即便后面整页刷新，应用启动时也会打开这个会话（而非列表第一个）。
    updateSessionNav(id);

    root.dispatchEvent(
      new CustomEvent(NAV_EVENT, {
        detail: { id, targets },
      })
    );

    // 1) 列表里能找到该群 → 点击真实条目，SPA 切换，绝不刷新。
    if (clickListItem(root, id)) {
      return { ok: true, method: "list-click" };
    }

    // 2) 列表里没有（被虚拟化/未加载）→ 导航到带「真实 chatId」的网页地址。
    //    可能整页刷新，但因为带的是真实 chatId + 已写入导航状态，一定进正确的群。
    hardNavigate(root, targets[0]);
    return { ok: true, method: "navigate", url: targets[0] };
  }

  window.addEventListener(OPEN_CHAT_EVENT, (event) => {
    const id = String(event.detail?.id || "").trim();
    if (!id) return;
    openConversation({ id, title: event.detail?.title || "" });
  });

  window.TeamsNav = {
    openConversation,
    buildDeepLink: (id) => buildWebTargets(id)[0],
    updateSessionNav,
    buildWebTargets,
  };
})();

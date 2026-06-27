/** 聊天内群组链接 + 邀请链接处理（仅顶层窗口） */
(function () {
  if (window !== window.top) return;

  const TOAST_ID = "teams-filter-link-toast";
  const OPENED_EVENT = "teams-filter-link-opened";
  const FAILED_EVENT = "teams-filter-link-failed";
  const INVITE_PENDING = "teams-filter-invite-pending";
  const INVITE_RESOLVED = "teams-filter-invite-resolved";
  const INVITE_FAILED = "teams-filter-invite-failed";

  function displayTitle(title, id) {
    return window.TeamsTitles?.displayTitle?.(title, id) || title || window.TeamsTitles?.UNNAMED || "未命名群组";
  }

  function rememberGroup(id, title, source) {
    if (!id) return;
    chrome.storage.local.get({ discoveredGroups: [] }, (data) => {
      const list = Array.isArray(data?.discoveredGroups) ? data.discoveredGroups : [];
      const entry = {
        id,
        title: displayTitle(title, id),
        source: source || "link",
        seenAt: Date.now(),
      };
      const next = [entry, ...list.filter((item) => item.id !== id)].slice(0, 300);
      chrome.storage.local.set({ discoveredGroups: next }, () => void chrome.runtime.lastError);
    });
  }

  function showToast(text) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.className = "teams-filter-link-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  async function openResolvedGroup(chatId, title, source) {
    rememberGroup(chatId, title, source);
    await window.TeamsNav?.openConversation?.({ id: chatId, title });
    showToast(`正在打开：${displayTitle(title, chatId)}`);
  }

  async function fallbackExistingGroup(detail) {
    const title = String(detail?.resolvedTitle || detail?.title || "").trim();
    const inviteUrl = String(detail?.inviteUrl || "").trim();
    const hit = await window.TeamsGroups?.lookupGroupByInviteHint?.({ inviteUrl, title });
    if (!hit?.id) return false;
    await openResolvedGroup(hit.id, hit.title || title, "invite-member");
    return true;
  }

  window.addEventListener(OPENED_EVENT, (event) => {
    const id = String(event.detail?.id || "").trim();
    const title = String(event.detail?.title || "").trim();
    if (!id) return;
    rememberGroup(id, title, "link");
    showToast(`正在打开：${displayTitle(title, id)}`);
  });

  window.addEventListener(FAILED_EVENT, () => {
    showToast("网页内打开失败，请用插件列表搜索群名或粘贴群 ID");
  });

  window.addEventListener(INVITE_PENDING, (event) => {
    const title = String(event.detail?.title || "").trim();
    showToast(title ? `正在打开：${title}` : "正在解析邀请链接…");
  });

  window.addEventListener(INVITE_RESOLVED, async (event) => {
    const chatId = String(event.detail?.chatId || "").trim();
    const title = String(event.detail?.resolvedTitle || event.detail?.title || "").trim();

    if (chatId && window.TeamsNav?.openConversation) {
      await openResolvedGroup(chatId, title, "invite");
      return;
    }

    if (await fallbackExistingGroup(event.detail)) return;

    // 不再自动刷新到网页邀请页：那样会丢失目标群、回到聊天列表第一个。
    // 只在确实拿到 chatId 时软跳转；拿不到就提示，不破坏当前页面。
    showToast("没找到该群（未刷新页面）。请先打开「聊天」列表后重试，或在插件里搜索群名/「用链接打开」");
  });

  window.addEventListener("teams-filter-invite-joined", (event) => {
    const chatId = String(event.detail?.chatId || "").trim();
    if (!chatId) return;
    rememberGroup(chatId, "", "invite-join");
    showToast("已加入，正在打开群聊…");
  });

  window.addEventListener(INVITE_FAILED, () => {
    showToast("已拦截桌面版跳转。请用插件搜索群名，或向群主索取群 ID");
  });

  async function getDiscoveredGroups() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ discoveredGroups: [] }, (data) => {
        resolve(Array.isArray(data?.discoveredGroups) ? data.discoveredGroups : []);
        void chrome.runtime.lastError;
      });
    });
  }

  async function openInviteUrl(inviteUrl, title) {
    const url = window.TeamsInvite?.normalizeInviteUrl?.(inviteUrl) || inviteUrl;
    if (!url) return { ok: false, reason: "invalid-invite" };

    window.dispatchEvent(new CustomEvent(INVITE_PENDING, { detail: { inviteUrl: url, title } }));

    if (window.TeamsInvite?.resolveInviteUrl) {
      const resolved = await window.TeamsInvite.resolveInviteUrl(url, title);
      if (resolved?.chatId) {
        window.dispatchEvent(
          new CustomEvent(INVITE_RESOLVED, {
            detail: {
              inviteUrl: url,
              title,
              chatId: resolved.chatId,
              resolvedTitle: resolved.title || "",
            },
          })
        );
        return { ok: true, chatId: resolved.chatId };
      }

      const hit = await window.TeamsGroups?.lookupGroupByInviteHint?.({ inviteUrl: url, title });
      if (hit?.id) {
        window.dispatchEvent(
          new CustomEvent(INVITE_RESOLVED, {
            detail: {
              inviteUrl: url,
              title,
              chatId: hit.id,
              resolvedTitle: hit.title || title,
            },
          })
        );
        return { ok: true, chatId: hit.id };
      }

      window.dispatchEvent(
        new CustomEvent(INVITE_RESOLVED, {
          detail: { inviteUrl: url, title, chatId: "", resolvedTitle: "" },
        })
      );
      return { ok: false, reason: "unresolved" };
    }

    window.dispatchEvent(
      new CustomEvent("teams-filter-resolve-invite", {
        detail: { inviteUrl: url, title },
      })
    );
    return { ok: true, pending: true };
  }

  window.TeamsLinkGroups = { getDiscoveredGroups, rememberGroup, openInviteUrl };
})();

/** 在 Teams 页面内打开指定会话 */
(function () {
  function escapeAttr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function clickChatElement(id) {
    const selectors = [
      `[data-conversation-id="${escapeAttr(id)}"]`,
      `[data-thread-id="${escapeAttr(id)}"]`,
      `[data-chat-id="${escapeAttr(id)}"]`,
    ];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const clickable = node.closest('[role="treeitem"], [role="listitem"], [role="option"], button, a') || node;
        clickable.scrollIntoView({ block: "nearest" });
        clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        if (clickable.click) clickable.click();
        return true;
      }
    }

    for (const node of document.querySelectorAll('[role="treeitem"], [role="listitem"], [role="option"]')) {
      const blob = `${node.outerHTML} ${node.getAttribute("aria-label") || ""}`;
      if (blob.includes(id)) {
        node.scrollIntoView({ block: "nearest" });
        node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        if (node.click) node.click();
        return true;
      }
    }
    return false;
  }

  function openConversation(id) {
    if (!id) return false;
    if (clickChatElement(id)) return true;

    const base = location.origin.includes("teams.live.com")
      ? "https://teams.live.com/v2/"
      : "https://teams.microsoft.com/v2/";
    try {
      const url = new URL(base);
      url.searchParams.set("chatId", id);
      history.pushState({}, "", url.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
      return true;
    } catch {
      return false;
    }
  }

  function readCurrentConversationMeta() {
    const id = window.TeamsNotifyIdb?.readActiveConversationId?.() || null;
    if (!id) return null;

    let title = "";
    const active = document.querySelector('[aria-selected="true"], [data-selected="true"]');
    if (active) {
      title = (active.getAttribute("aria-label") || active.textContent || "").trim().split(",")[0].trim();
    }
    if (!title) title = id.split("@")[0];

    const chatType = id.includes("@oneToOne") ? "private" : "group";
    return { id, title, chatType, unreadCount: 0, source: "active" };
  }

  window.TeamsNotifyNav = {
    openConversation,
    readCurrentConversationMeta,
  };
})();

/** 共享：从 Teams 聊天列表解析会话（DOM + IndexedDB） */
(function () {
  const SKIP_TITLE =
    /^(activity|calendar|calls|files|apps|discover|copilot|mentions|saved|teams|chat|chats|unread|more|recent)$/i;

  const CHAT_ITEM_SELECTORS = [
    '[role="treeitem"]',
    '[role="listitem"]',
    '[role="option"]',
    '[role="row"]',
    '[data-tid*="chat-list-item"]',
    '[data-tid*="thread-list-item"]',
    '[data-tid*="recent-chat"]',
    '[data-conversation-id]',
    '[data-thread-id]',
  ];

  function normalizeTitle(title) {
    return String(title || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTitleKey(title) {
    return normalizeTitle(title).toLowerCase();
  }

  function extractThreadTitle(node) {
    const titleSelectors = [
      '[data-tid*="chat-list-item-title"]',
      '[data-tid*="thread-title"]',
      '[data-tid*="chat-title"]',
      '[data-tid*="title"]',
      '[class*="title"]',
      "span[dir]",
    ];
    for (const selector of titleSelectors) {
      const el = node.querySelector(selector);
      const text = normalizeTitle(el?.textContent);
      if (text && !SKIP_TITLE.test(text) && text.length < 100) return text;
    }

    const ariaLabel = normalizeTitle(node.getAttribute("aria-label"));
    if (!ariaLabel) return "";

    const cleaned = ariaLabel
      .replace(/\d+\s*unread.*/i, "")
      .replace(/未读.*/i, "")
      .replace(/last message.*/i, "")
      .replace(/has unread messages.*/i, "")
      .replace(/private chat with /i, "")
      .replace(/group chat with /i, "")
      .replace(/chat with /i, "")
      .trim();
    const first = cleaned.split(/,|，|·/)[0].trim();
    return normalizeTitle(first);
  }

  function extractUnreadCount(node) {
    const ariaText = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.toLowerCase();
    const patterns = [
      /(\d+)\s*unread/,
      /未读\s*(\d+)/,
      /(\d+)\s*new messages?/,
      /(\d+)\s*条未读/,
      /(\d+)\s*条新消息/,
    ];
    for (const pattern of patterns) {
      const match = ariaText.match(pattern);
      if (match?.[1]) return Number(match[1]);
    }

    const badge = node.querySelector(
      '[aria-label*="unread" i], [data-tid*="unread"], [class*="unread"], [class*="badge"], [class*="counter"]'
    );
    if (!badge) return 0;
    const text = (badge.textContent || badge.getAttribute("aria-label") || "").trim();
    if (!text) return 1;
    const num = Number(text.replace(/[^\d]/g, ""));
    return Number.isFinite(num) && num > 0 ? num : 1;
  }

  function countAvatars(node) {
    const avatars = node.querySelectorAll(
      'img[alt*="avatar" i], [data-tid*="avatar"], [class*="avatar"]'
    );
    return avatars.length;
  }

  function detectChatType(node, title) {
    const aria = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tid") || ""}`.toLowerCase();
    const blob = `${aria} ${title}`.toLowerCase();

    if (
      /private chat|direct message|personal chat|1:1|1-on-1|私人|个人聊天|单聊|chat with |message with /.test(blob) &&
      !/group chat|team chat|channel|群聊|团队|members|participants/.test(blob)
    ) {
      return "private";
    }

    if (
      /group chat|team chat|channel|群聊|团队|meeting chat|shared|members|participants|\d+\s+people|\d+\s+members/.test(
        blob
      )
    ) {
      return "group";
    }

    const hasGroupIcon = node.querySelector(
      '[data-icon-name="People"], [data-icon-name="Teamwork"], [data-icon-name="Channel"], [data-icon-name="TeamsLogo"]'
    );
    const hasPersonIcon = node.querySelector(
      '[data-icon-name="Person"], [data-icon-name="Contact"], [data-icon-name="SkypeCircleCheck"]'
    );

    if (hasGroupIcon && !hasPersonIcon) return "group";
    if (hasPersonIcon && !hasGroupIcon) return "private";

    const avatarCount = countAvatars(node);
    if (avatarCount >= 2) return "group";

    if (/[,，]| and | & |\+ \d+|\(\d+\)/i.test(title)) return "group";

    if (title.length <= 40 && !/\d/.test(title)) return "private";

    return "group";
  }

  function extractIdFromHref(value) {
    const text = String(value || "");
    const patterns = [
      /\/conversations\/([^/?#]+)/i,
      /\/chats\/([^/?#]+)/i,
      /conversationId=([^&#]+)/i,
      /threadId=([^&#]+)/i,
      /\/l\/chat\/([^/?#]+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return decodeURIComponent(match[1]).trim();
    }
    return "";
  }

  function extractThreadId(node, title, chatType) {
    let current = node;
    for (let depth = 0; depth < 6 && current; depth++) {
      const attrs = [
        current.getAttribute("data-conversation-id"),
        current.getAttribute("data-thread-id"),
        current.getAttribute("data-chat-id"),
        current.getAttribute("data-id"),
        current.getAttribute("data-item-id"),
      ];
      for (const attr of attrs) {
        const value = String(attr || "").trim();
        if (value && value.length > 2 && !/^treeitem/i.test(value)) return value;
      }
      current = current.parentElement;
    }

    const links = node.querySelectorAll("a[href]");
    for (const link of links) {
      const fromHref = extractIdFromHref(link.getAttribute("href"));
      if (fromHref) return fromHref;
    }

    return `${chatType}:${normalizeTitleKey(title)}`;
  }

  function isNavItem(title, aria) {
    return (
      SKIP_TITLE.test(title) ||
      /activity|calendar|calls|files|apps|copilot|mentions|saved|discover|invite|settings/i.test(aria)
    );
  }

  function isChatItem(node) {
    if (!(node instanceof Element)) return false;

    const role = node.getAttribute("role") || "";
    const tid = node.getAttribute("data-tid") || "";
    const hasConvAttr =
      node.hasAttribute("data-conversation-id") ||
      node.hasAttribute("data-thread-id") ||
      node.hasAttribute("data-chat-id");

    const isRoleMatch = ["treeitem", "listitem", "option", "row"].includes(role);
    const isTidMatch = /chat-list-item|thread-list-item|recent-chat|chat-list/i.test(tid);

    if (!isRoleMatch && !isTidMatch && !hasConvAttr) return false;

    const title = extractThreadTitle(node);
    const aria = (node.getAttribute("aria-label") || "").toLowerCase();

    if (isNavItem(title, aria)) return false;
    if (!title && !hasConvAttr) return false;
    if (title && title.length > 120) return false;

    return true;
  }

  function findScrollableList(root) {
    let el = root;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function scrollChatListToLoadAll() {
    const roots = document.querySelectorAll(
      '[data-tid*="chat-list"], [aria-label*="Chat list" i], [aria-label*="聊天" i], [data-tid*="left-rail"]'
    );
    const scrollers = new Set();
    for (const root of roots) {
      const scroller = findScrollableList(root);
      if (scroller) scrollers.add(scroller);
    }

    for (const el of scrollers) {
      const step = Math.max(120, Math.floor(el.clientHeight * 0.75));
      let lastTop = -1;
      for (let i = 0; i < 40; i++) {
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        await new Promise((r) => setTimeout(r, 60));
        if (el.scrollTop === lastTop) break;
        lastTop = el.scrollTop;
      }
      el.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  function getChatTreeItems() {
    let bestItems = [];

    const allSelectors = [
      '[data-tid="chat-list"]',
      '[data-tid*="chat-list"]',
      '[data-tid*="recent-chats"]',
      '[aria-label*="Chat list" i]',
      '[aria-label*="聊天" i]',
      '[data-tid*="left-rail"]',
      "#chat-list",
      '[role="tree"]',
      '[role="list"]',
      '[role="listbox"]',
    ];

    for (const selector of allSelectors) {
      for (const root of document.querySelectorAll(selector)) {
        const localSeen = new Set();
        const items = [];
        collectItemsFromRoot(root, localSeen, items);
        if (items.length > bestItems.length) bestItems = items;
      }
    }

    if (!bestItems.length && document.body) {
      const localSeen = new Set();
      bestItems = [];
      collectItemsFromRoot(document.body, localSeen, bestItems);
    }

    return bestItems;
  }

  function collectItemsFromRoot(root, seen, items) {
    for (const itemSelector of CHAT_ITEM_SELECTORS) {
      for (const node of root.querySelectorAll(itemSelector)) {
        if (!isChatItem(node)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
        items.push(node);
      }
    }
  }

  function resolveChatType(thread, catalog) {
    const entry = catalog?.[thread.id];
    if (entry?.chatType === "private" || entry?.chatType === "group") {
      return entry.chatType;
    }
    const titleKey = normalizeTitleKey(thread.title);
    for (const [id, meta] of Object.entries(catalog || {})) {
      if (normalizeTitleKey(meta?.title) === titleKey && (meta.chatType === "private" || meta.chatType === "group")) {
        return meta.chatType;
      }
    }
    return thread.chatType;
  }

  function threadFromNode(node, catalog) {
    const title = extractThreadTitle(node);
    if (!title) return null;
    const detectedType = detectChatType(node, title);
    const id = extractThreadId(node, title, detectedType);
    const chatType = resolveChatType({ id, title, chatType: detectedType }, catalog);
    return {
      id,
      title,
      chatType,
      unreadCount: extractUnreadCount(node),
      source: "dom",
    };
  }

  function mergeThreads(domThreads, idbThreads, catalog) {
    const map = new Map();

    for (const t of idbThreads || []) {
      if (!t?.id) continue;
      map.set(t.id, {
        ...t,
        chatType: resolveChatType(t, catalog),
      });
    }

    for (const t of domThreads || []) {
      if (!t?.id) continue;
      const prev = map.get(t.id);
      if (!prev) {
        map.set(t.id, t);
        continue;
      }
      map.set(t.id, {
        ...prev,
        title: t.title || prev.title,
        unreadCount: Math.max(t.unreadCount || 0, prev.unreadCount || 0),
        chatType: resolveChatType(
          { ...prev, chatType: t.chatType !== "group" ? t.chatType : prev.chatType },
          catalog
        ),
        source: "merged",
      });
    }

    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  function collectAllThreadsFromDom(catalog) {
    const map = new Map();
    for (const node of getChatTreeItems()) {
      const thread = threadFromNode(node, catalog);
      if (!thread) continue;
      map.set(thread.id, thread);
    }
    return [...map.values()];
  }

  function collectAllThreads(catalog) {
    const dom = collectAllThreadsFromDom(catalog);
    const idb = window.TeamsNotifyIdb?.getCachedIdbThreads?.() || [];
    return mergeThreads(dom, idb, catalog);
  }

  async function collectAllThreadsAsync(catalog, options = {}) {
    if (options.scrollList !== false) {
      await scrollChatListToLoadAll();
    }
    if (window.TeamsNotifyIdb?.refreshIdbThreads) {
      await window.TeamsNotifyIdb.refreshIdbThreads(!!options.forceIdb);
    }
    return collectAllThreads(catalog);
  }

  function collectUnreadThreads(catalog) {
    return collectAllThreads(catalog).filter((t) => t.unreadCount > 0);
  }

  window.TeamsNotifyUtils = {
    collectAllThreads,
    collectAllThreadsAsync,
    collectUnreadThreads,
    scrollChatListToLoadAll,
    detectChatType,
    normalizeTitleKey,
  };
})();

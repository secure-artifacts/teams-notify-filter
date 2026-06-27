(function () {
  if (window.__teamsFilterNavBridgeInstalled) return;
  window.__teamsFilterNavBridgeInstalled = true;

  const NAV_EVENT = "teams-filter-navigate";
  const NAV_KEY_PATTERNS = [
    /^tmp\.session\.(.+)-mainWindowNavHistory$/,
    /^live\.session\.(.+)-mainWindowNavHistory$/,
    /^session\.(.+)-mainWindowNavHistory$/,
  ];

  function updateSessionNav(id) {
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key || !NAV_KEY_PATTERNS.some((pattern) => pattern.test(key))) continue;

        let data;
        try {
          data = JSON.parse(sessionStorage.getItem(key) || "{}");
        } catch {
          data = {};
        }

        const entity = {
          action: "view",
          id,
          entityType: "Conversation",
          type: "Conversation",
        };

        if (!data.activeEntities || typeof data.activeEntities !== "object") {
          data.activeEntities = {};
        }
        data.activeEntities.mainEntity = entity;

        sessionStorage.setItem(key, JSON.stringify(data));
      }
    } catch {
      /* ignore */
    }
  }

  window.addEventListener(NAV_EVENT, (event) => {
    const id = String(event.detail?.id || "").trim();
    if (!id.startsWith("19:")) return;
    updateSessionNav(id);
  });
})();

(function () {
  if (window.__teamsNotificationFilterInstalled) return;
  window.__teamsNotificationFilterInstalled = true;

  const OriginalNotification = window.Notification;
  if (!OriginalNotification) return;

  let enabled = true;
  let mode = "allow_list";
  let keywords = [];
  let threads = [];

  function applyConfig(detail) {
    if (!detail || typeof detail !== "object") return;
    enabled = detail.enabled !== false;
    mode = detail.mode === "block_list" ? "block_list" : "allow_list";
    keywords = Array.isArray(detail.keywords)
      ? detail.keywords.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    threads = Array.isArray(detail.threads)
      ? detail.threads
          .map((item) => ({
            id: String(item?.id || "").trim(),
            title: String(item?.title || "").trim(),
          }))
          .filter((item) => item.id || item.title)
      : [];
  }

  window.addEventListener("teams-filter-config", (event) => {
    applyConfig(event.detail);
  });

  applyConfig({
    enabled: window.__teams_filter_enabled !== false,
    mode: window.__teams_filter_mode || "allow_list",
    keywords: window.__teams_filter_keywords || window.__teams_filter_blacklist || [],
    threads: window.__teams_filter_threads || [],
  });

  function createBlockedStub(title, options) {
    return {
      title: String(title || ""),
      body: String(options?.body || ""),
      tag: String(options?.tag || ""),
      data: options?.data ?? null,
      onclick: null,
      onshow: null,
      onerror: null,
      onclose: null,
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }

  function notificationText(title, options) {
    return `${title || ""} ${options?.body || ""}`.toLowerCase();
  }

  function isConversationId(value) {
    const text = String(value || "").trim();
    if (text.length < 8) return false;
    return text.includes("@") && (text.startsWith("19:") || text.includes("@thread"));
  }

  function extractConversationId(options) {
    const candidates = [];
    const data = options?.data;

    if (data && typeof data === "object") {
      candidates.push(data.chatId, data.conversationId, data.threadId, data.id);
    } else if (typeof data === "string") {
      candidates.push(data);
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object") {
          candidates.push(parsed.chatId, parsed.conversationId, parsed.threadId, parsed.id);
        }
      } catch {
        /* ignore */
      }
    }

    candidates.push(options?.tag);

    for (const raw of candidates) {
    const text = String(raw || "").trim();
    if (isConversationId(text)) return text;
    const match = text.match(/(19:[^"'\\s]+@thread[^\s"'\\s]*)/i);
    if (match?.[1] && isConversationId(match[1])) return match[1];
    }

    return "";
  }

  function idsMatch(a, b) {
    const left = String(a || "").trim();
    const right = String(b || "").trim();
    if (!left || !right) return false;
    return left === right;
  }

  function matchesKeyword(text) {
    if (!keywords.length) return false;
    const hay = String(text || "").toLowerCase();
    return keywords.some((keyword) => {
      const needle = String(keyword || "").trim().toLowerCase();
      if (!needle) return false;
      if (needle.length <= 2) return hay.includes(needle);
      const re = new RegExp(`(?:^|[\\s，,.!?;:()\\[\\]「」【】])${escapeRegExp(needle)}(?:$|[\\s，,.!?;:()\\[\\]「」【】])`);
      return re.test(hay) || hay.includes(needle);
    });
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function matchesThread(options, text) {
    const conversationId = extractConversationId(options);
    if (!threads.length) return false;

    for (const thread of threads) {
      if (conversationId && thread.id && idsMatch(conversationId, thread.id)) return true;
      const cleanTitle = String(thread.title || "")
        .replace(/^\[会议\]\s*/, "")
        .trim()
        .toLowerCase();
      if (cleanTitle && text.includes(cleanTitle)) return true;
    }
    return false;
  }

  function looksLikeGroupNotification(title, options) {
    const text = notificationText(title, options);
    const tag = String(options?.tag || "").toLowerCase();
    const conversationId = extractConversationId(options);

    if (conversationId && threads.some((thread) => idsMatch(conversationId, thread.id))) {
      return true;
    }

    const groupPatterns = [
      /\bin\s+\S+/i,
      /posted in/i,
      /sent a message in/i,
      /replied in/i,
      /mentioned you in/i,
      /reacted to.*in/i,
      /在.+?(群|组|频道|团队|群聊)/,
      /群聊/,
      /\(group\)/i,
      /\(channel\)/i,
      /\(team\)/i,
    ];

    if (groupPatterns.some((pattern) => pattern.test(text))) return true;
    if (/group|channel|team|thread|conversation/i.test(tag)) return true;
    return false;
  }

  function looksLikePrivateNotification(title, options) {
    if (looksLikeGroupNotification(title, options)) return false;
    return !!String(title || "").trim();
  }

  function shouldBlock(title, options) {
    if (!enabled) return false;

    const text = notificationText(title, options);
    const inThreadList = matchesThread(options, text);

    if (mode === "block_list") {
      if (inThreadList) return true;
      if (!keywords.length) return false;
      return matchesKeyword(text);
    }

    if (inThreadList) return false;
    if (matchesKeyword(text)) return false;
    if (looksLikePrivateNotification(title, options)) return false;
    return true;
  }

  function FilteredNotification(title, options) {
    if (shouldBlock(title, options)) {
      return createBlockedStub(title, options);
    }
    return new OriginalNotification(title, options);
  }

  FilteredNotification.prototype = OriginalNotification.prototype;
  Object.setPrototypeOf(FilteredNotification, OriginalNotification);

  for (const key of Object.getOwnPropertyNames(OriginalNotification)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const desc = Object.getOwnPropertyDescriptor(OriginalNotification, key);
    if (desc) Object.defineProperty(FilteredNotification, key, desc);
  }

  if (typeof OriginalNotification.requestPermission === "function") {
    FilteredNotification.requestPermission = OriginalNotification.requestPermission.bind(OriginalNotification);
  }

  window.Notification = FilteredNotification;
})();

/**
 * 群组/会议 thread 读取
 * 来源：聊天列表 DOM、活动 feed DOM、当前 URL、conversation-manager IDB
 */
(function () {
  const T = () => window.TeamsTitles;

  let cache = [];
  let cacheAt = 0;
  const CACHE_MS = 45000;

  const ID_IN_TEXT = /19:[a-zA-Z0-9_+\-]+@thread[^\s"'<>]*/gi;

  function extractIdsFromText(text) {
    const hits = String(text || "").match(ID_IN_TEXT) || [];
    return [...new Set(hits.map((id) => id.trim()))].filter((id) => T()?.isThreadId?.(id));
  }

  function deepFindMeetingTitle(obj, depth = 0) {
    if (!obj || depth > 5) return "";
    if (typeof obj === "string") return T()?.pickTitle?.(obj) || "";
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const hit = deepFindMeetingTitle(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof obj !== "object") return "";

    const priority = [
      "meetingTitle",
      "subject",
      "topic",
      "calendarEventSubject",
      "calendarEventTitle",
      "chatTitle",
      "title",
      "displayName",
      "name",
      "activityTitle",
      "callTitle",
    ];
    for (const key of priority) {
      if (obj[key] != null) {
        const hit = deepFindMeetingTitle(obj[key], depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  }

  function titleFromConv(conv) {
    const direct = T()?.pickTitle?.(
      conv?.threadProperties?.topic,
      conv?.threadProperties?.meetingTitle,
      conv?.threadProperties?.subject,
      conv?.threadProperties?.calendarEventSubject,
      conv?.threadProperties?.calendarEventTitle,
      conv?.topic,
      conv?.meetingTitle,
      conv?.subject,
      conv?.name,
      conv?.displayName,
      conv?.calendarEventSubject,
      conv?.calendarEventTitle,
      conv?.activityTitle,
      conv?.callTitle,
      localeText(conv?.chatTitle),
      localeText(conv?.title),
      localeText(conv?.properties?.chatTitle),
      localeText(conv?.properties?.subject)
    );
    if (direct) return direct;

    const id = String(conv?.id || conv?.conversationId || "").trim();
    if (T()?.isMeetingId?.(id)) return deepFindMeetingTitle(conv);
    return "";
  }

  function localeText(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    for (const v of Object.values(value)) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  function readFromDomLists(selectors, source) {
    const byId = new Map();

    for (const selector of selectors) {
      for (const item of document.querySelectorAll(selector)) {
        const title = extractDomTitle(item);
        const id = extractDomId(item);
        if (!id || !T()?.isThreadId?.(id)) continue;
        if (!title) continue;

        const display = T()?.displayTitle?.(title, id) || title;
        byId.set(id, { id, title: display, source, kind: T()?.isMeetingId?.(id) ? "meeting" : "chat" });
      }
    }

    return byId;
  }

  function readFromDom() {
    const chat = readFromDomLists(
      [
        '[data-tid="chat-list"] [role="treeitem"]',
        '[data-tid*="chat-list"] [role="treeitem"]',
        '[data-testid*="chat-list"] [role="treeitem"]',
      ],
      "chat-list"
    );

    const activity = readFromDomLists(
      [
        '[data-tid*="activity"] [role="listitem"]',
        '[data-tid*="activity"] [role="article"]',
        '[data-tid*="activity"] [role="treeitem"]',
        '[data-tid*="activity"] [role="button"]',
        '[data-tid*="feed"] [role="listitem"]',
        '[data-tid*="feed"] [role="article"]',
        '[data-tid*="call"] [role="listitem"]',
        '[data-tid*="call"] [role="treeitem"]',
        '[data-tid*="meeting"] [role="listitem"]',
        '[data-tid*="recent"] [role="listitem"]',
        '[aria-label*="Activity"] [role="listitem"]',
        '[aria-label*="活动"] [role="listitem"]',
        '[aria-label*="Call"] [role="listitem"]',
        '[aria-label*="通话"] [role="listitem"]',
      ],
      "activity"
    );

    const byId = new Map([...chat, ...activity]);
    const byTitle = new Map();
    for (const [, entry] of byId) {
      byTitle.set(entry.title.replace(/^\[会议\]\s*/, "").toLowerCase(), entry);
    }

    return { byId, byTitle };
  }

  function readFromLocation() {
    const byId = new Map();
    const haystack = [
      location.href,
      location.hash,
      location.search,
      document.referrer,
    ].join("\n");

    for (const hit of extractIdsFromText(haystack)) {
      if (byId.has(hit)) continue;
      const title = readOpenConversationTitle() || readDocumentTitle();
      if (!title) continue;
      byId.set(hit, {
        id: hit,
        title: T()?.displayTitle?.(title, hit) || title,
        source: "url",
        kind: T()?.isMeetingId?.(hit) ? "meeting" : "chat",
      });
    }
    return byId;
  }

  function readDocumentTitle() {
    return T()?.pickTitle?.(document.title.replace(/\s*[|\-–—].*$/, "").trim());
  }

  function readOpenConversationTitle() {
    for (const sel of [
      '[data-tid*="chat-header"] [data-tid*="title"]',
      '[data-tid*="conversation-header"] [data-tid*="title"]',
      '[data-tid*="meeting-title"]',
      '[data-tid*="chat-header"] h1',
      '[data-tid*="chat-header"] h2',
      '[data-tid*="chat-pane-header"] h1',
      '[data-tid*="chat-pane-header"] h2',
      '[data-tid*="chat-header"]',
      'header [role="heading"]',
    ]) {
      const text = T()?.pickTitle?.(document.querySelector(sel)?.textContent);
      if (text) return text;
    }
    return "";
  }

  function readFromChatHeader() {
    const byId = new Map();
    const ids = extractIdsFromText(location.href);
    const title = readOpenConversationTitle() || readDocumentTitle();
    if (!title) return byId;

    for (const id of ids) {
      byId.set(id, {
        id,
        title: T()?.displayTitle?.(title, id) || title,
        source: "header",
        kind: T()?.isMeetingId?.(id) ? "meeting" : "chat",
      });
    }
    return byId;
  }

  function matchActivityTitlesToIdb(dom, idbMap) {
    const byId = new Map();
    const activitySelectors = [
      '[data-tid*="activity"] [role="listitem"]',
      '[data-tid*="activity"] [role="article"]',
      '[data-tid*="feed"] [role="listitem"]',
      '[data-tid*="call"] [role="listitem"]',
      '[data-tid*="meeting"] [role="listitem"]',
      '[aria-label*="活动"] [role="listitem"]',
      '[aria-label*="通话"] [role="listitem"]',
    ];

    for (const selector of activitySelectors) {
      for (const item of document.querySelectorAll(selector)) {
        if (extractDomId(item)) continue;
        const title = extractDomTitle(item);
        if (!title) continue;

        const norm = title.toLowerCase();
        for (const [id, entry] of idbMap) {
          if (!T()?.isMeetingId?.(id)) continue;
          const idbTitle = String(entry.title || "")
            .replace(/^\[会议\]\s*/, "")
            .trim()
            .toLowerCase();
          if (!idbTitle) continue;
          if (idbTitle === norm || idbTitle.includes(norm) || norm.includes(idbTitle)) {
            byId.set(id, {
              id,
              title: T()?.displayTitle?.(entry.title.replace(/^\[会议\]\s*/, "") || title, id) || `[会议] ${title}`,
              source: "activity-match",
              kind: "meeting",
            });
            break;
          }
        }
      }
    }

    for (const [id, entry] of dom.byId) {
      if (entry.source !== "activity" || byId.has(id)) continue;
      const norm = entry.title.replace(/^\[会议\]\s*/, "").toLowerCase();
      for (const [idbId, idbEntry] of idbMap) {
        if (!T()?.isMeetingId?.(idbId) || byId.has(idbId)) continue;
        const idbTitle = String(idbEntry.title || "")
          .replace(/^\[会议\]\s*/, "")
          .trim()
          .toLowerCase();
        if (idbTitle && (idbTitle === norm || idbTitle.includes(norm) || norm.includes(idbTitle))) {
          byId.set(idbId, {
            id: idbId,
            title: T()?.displayTitle?.(idbEntry.title.replace(/^\[会议\]\s*/, "") || entry.title.replace(/^\[会议\]\s*/, ""), idbId),
            source: "activity-match",
            kind: "meeting",
          });
        }
      }
    }

    return byId;
  }

  function extractDomTitle(item) {
    for (const sel of [
      '[data-tid*="chat-list-item-title"]',
      '[data-testid*="chat-list-item-title"]',
      '[data-tid*="activity-title"]',
      '[data-tid*="title"]',
    ]) {
      const text = T()?.normalizeTitle?.(item.querySelector(sel)?.textContent);
      if (text && !T()?.isLikelyGarbageTitle?.(text)) return text;
    }

    const aria = T()?.normalizeTitle?.(item.getAttribute("aria-label"));
    if (aria) {
      const head = aria
        .replace(/\d+\s*unread.*/i, "")
        .replace(/未读.*/i, "")
        .replace(/meeting/i, "")
        .split(/[,，·]/)[0]
        .trim();
      if (head && !T()?.isLikelyGarbageTitle?.(head)) return head;
    }
    return "";
  }

  function extractDomId(item) {
    for (const el of [item, ...item.querySelectorAll("a[href], [href]")]) {
      const href = String(el.getAttribute("href") || "");
      const fromHref = extractIdsFromText(href)[0];
      if (fromHref) return fromHref;
    }

    for (const el of [item, ...item.querySelectorAll("*")]) {
      for (const attr of el.attributes || []) {
        const hit = extractIdsFromText(attr.value)[0];
        if (hit) return hit;
      }
    }

    for (const attr of ["data-conversation-id", "data-thread-id", "data-chat-id"]) {
      const v = String(item.getAttribute(attr) || "").trim();
      if (T()?.isThreadId?.(v)) return v;
    }
    return "";
  }

  function lookupInDom(id) {
    for (const item of document.querySelectorAll('[role="treeitem"], [role="listitem"], [role="article"]')) {
      if (extractDomId(item) !== id) continue;
      const title = extractDomTitle(item);
      if (!title) continue;
      return T()?.displayTitle?.(title, id) || title;
    }
    return "";
  }

  function findTitleInRow(row, targetId) {
    const list = Array.isArray(row?.conversations) ? row.conversations : row?.id ? [row] : [];
    for (const conv of list) {
      const cid = String(conv?.id || conv?.conversationId || "").trim();
      if (cid !== targetId) continue;
      return titleFromConv(conv) || deepFindMeetingTitle(conv);
    }
    return "";
  }

  async function lookupInIdb(id) {
    if (typeof indexedDB.databases !== "function") return "";

    let dbs;
    try {
      dbs = await indexedDB.databases();
    } catch {
      return "";
    }

    for (const meta of dbs) {
      if (!meta.name) continue;
      if (!/conversation-folder-manager|conversation-manager/i.test(meta.name)) continue;

      const db = await openDb(meta.name);
      if (!db) continue;

      try {
        for (const storeName of db.objectStoreNames) {
          if (!/conversation|folder|chat/i.test(storeName)) continue;
          const rows = await readStore(db, storeName);
          for (const row of rows) {
            const rawTitle = findTitleInRow(row, id);
            if (rawTitle) {
              return T()?.displayTitle?.(rawTitle, id) || rawTitle;
            }
          }
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
    return "";
  }

  function normalizeSearchTitle(title) {
    return String(title || "")
      .replace(/^\[会议\]\s*/, "")
      .replace(/^(join|加入|open chat|打开聊天)\s*/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function titleMatches(query, candidate) {
    const q = normalizeSearchTitle(query);
    const c = normalizeSearchTitle(candidate);
    if (!q || !c) return false;
    if (q === c) return true;
    if (q.length < 2 || c.length < 2) return false;
    if (q.length >= 4 || c.length >= 4) return c.includes(q) || q.includes(c);
    return false;
  }

  async function lookupInIdbByInvite(token, inviteUrl) {
    if ((!token && !inviteUrl) || typeof indexedDB.databases !== "function") return null;

    const needles = [token, inviteUrl].filter(Boolean);
    let dbs;
    try {
      dbs = await indexedDB.databases();
    } catch {
      return null;
    }

    for (const meta of dbs) {
      if (!meta.name || !/conversation-folder-manager|conversation-manager/i.test(meta.name)) continue;
      const db = await openDb(meta.name);
      if (!db) continue;

      try {
        for (const storeName of db.objectStoreNames) {
          if (!/conversation|folder|chat/i.test(storeName)) continue;
          const rows = await readStore(db, storeName);
            for (const row of rows) {
            const rowBlob = JSON.stringify(row);
            const rowHasNeedle = needles.some((n) => rowBlob.includes(n));
            const list = Array.isArray(row?.conversations) ? row.conversations : row?.id ? [row] : [];

            if (rowHasNeedle) {
              // 仅返回「自身数据确实包含该邀请 token/URL」的会话；
              // 多会话文件夹里没命中的一律跳过，避免误跳到第一个/任意群。
              for (const conv of list) {
                const blob = JSON.stringify(conv);
                if (!needles.some((n) => blob.includes(n)) && list.length > 1) continue;
                const id = String(conv?.id || conv?.conversationId || "").trim();
                if (!T()?.isThreadId?.(id)) continue;
                const rawTitle = titleFromConv(conv);
                return {
                  id,
                  title: T()?.displayTitle?.(rawTitle, id) || rawTitle || T()?.UNNAMED || "未命名群组",
                  source: "idb-invite",
                };
              }
            }
          }
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  async function lookupGroupByTitle(title, options = {}) {
    const query = String(title || "").trim();
    if (!query || T()?.isIdLikeTitle?.(query)) return null;

    if (options.forceRefresh !== false) {
      await collectGroupsAsync(true);
    }

    for (const group of cache) {
      if (titleMatches(query, group.title)) {
        return { id: group.id, title: group.title, source: group.source || "title-match" };
      }
    }

    for (const item of document.querySelectorAll('[role="treeitem"], [role="listitem"]')) {
      const id = extractDomId(item);
      const domTitle = extractDomTitle(item);
      if (!id || !domTitle || !T()?.isThreadId?.(id)) continue;
      if (!titleMatches(query, domTitle)) continue;
      return {
        id,
        title: T()?.displayTitle?.(domTitle, id) || domTitle,
        source: "dom-title",
      };
    }

    return null;
  }

  async function lookupGroupByInviteHint({ inviteUrl = "", title = "" } = {}) {
    const token = String(inviteUrl || "").match(/\/l\/invite\/([^/?#]+)/i)?.[1] || "";

    const fromIdb = await lookupInIdbByInvite(token, inviteUrl);
    if (fromIdb?.id) return fromIdb;

    if (title) {
      const fromTitle = await lookupGroupByTitle(title);
      if (fromTitle?.id) return fromTitle;
    }

    return null;
  }

  async function lookupGroupById(id) {
    const threadId = String(id || "").trim();
    if (!T()?.isThreadId?.(threadId)) return null;

    const cached = cache.find((g) => g.id === threadId);
    if (cached?.title && !T()?.isIdLikeTitle?.(cached.title)) {
      return { id: threadId, title: cached.title, kind: cached.kind || "chat", source: "cache" };
    }

    const domTitle = lookupInDom(threadId);
    if (domTitle) return { id: threadId, title: domTitle, kind: T()?.isMeetingId?.(threadId) ? "meeting" : "chat", source: "dom" };

    const urlHit = readFromLocation().get(threadId) || readFromChatHeader().get(threadId);
    if (urlHit?.title) {
      return { id: threadId, title: urlHit.title, kind: urlHit.kind || "chat", source: urlHit.source || "url" };
    }

    const idbTitle = await lookupInIdb(threadId);
    if (idbTitle) {
      return {
        id: threadId,
        title: idbTitle,
        kind: T()?.isMeetingId?.(threadId) ? "meeting" : "chat",
        source: "idb",
      };
    }

    return null;
  }

  async function readFromIdb() {
    const map = new Map();
    if (typeof indexedDB.databases !== "function") return map;

    let dbs;
    try {
      dbs = await indexedDB.databases();
    } catch {
      return map;
    }

    for (const meta of dbs) {
      if (!meta.name) continue;
      if (!/conversation-folder-manager|conversation-manager/i.test(meta.name)) continue;

      const db = await openDb(meta.name);
      if (!db) continue;

      try {
        for (const storeName of db.objectStoreNames) {
          if (!/conversation|folder|chat/i.test(storeName)) continue;
          const rows = await readStore(db, storeName);
          for (const row of rows) ingestRow(row, map);
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
    return map;
  }

  function ingestRow(row, map) {
    const list = Array.isArray(row?.conversations) ? row.conversations : row?.id ? [row] : [];

    for (const conv of list) {
      const id = String(conv?.id || conv?.conversationId || "").trim();
      if (!T()?.isThreadId?.(id)) continue;

      const rawTitle = titleFromConv(conv);
      if (!rawTitle) continue;

      const title = T()?.displayTitle?.(rawTitle, id) || rawTitle;
      const prev = map.get(id);
      if (prev) {
        const better = T()?.pickTitle?.(prev.title.replace(/^\[会议\]\s*/, ""), rawTitle);
        if (better) {
          map.set(id, {
            id,
            title: T()?.displayTitle?.(better, id) || title,
            source: "idb",
            kind: T()?.isMeetingId?.(id) ? "meeting" : "chat",
          });
        }
        continue;
      }

      map.set(id, {
        id,
        title,
        source: "idb",
        kind: T()?.isMeetingId?.(id) ? "meeting" : "chat",
      });
    }
  }

  function openDb(name) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  function readStore(db, storeName) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  function merge(dom, urlMap, headerMap, activityMatchMap, idbMap) {
    const out = new Map();

    for (const [id, entry] of idbMap) {
      const domHit =
        dom.byId.get(id) ||
        urlMap.get(id) ||
        headerMap.get(id) ||
        activityMatchMap.get(id);
      const title = T()?.pickTitle?.(
        domHit?.title?.replace(/^\[会议\]\s*/, ""),
        entry.title?.replace(/^\[会议\]\s*/, "")
      );
      if (!title) continue;
      out.set(id, {
        id,
        title: T()?.displayTitle?.(title, id) || title,
        kind: entry.kind || (T()?.isMeetingId?.(id) ? "meeting" : "chat"),
      });
    }

    for (const source of [dom.byId, urlMap, headerMap, activityMatchMap]) {
      for (const [id, entry] of source) {
        out.set(id, {
          id,
          title: entry.title,
          kind: entry.kind || (T()?.isMeetingId?.(id) ? "meeting" : "chat"),
        });
      }
    }

    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  async function getDiscoveredGroups() {
    if (window.TeamsLinkGroups?.getDiscoveredGroups) {
      return window.TeamsLinkGroups.getDiscoveredGroups();
    }
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get({ discoveredGroups: [] }, (data) => {
        resolve(Array.isArray(data?.discoveredGroups) ? data.discoveredGroups : []);
        void chrome.runtime.lastError;
      });
    });
  }

  function mergeDiscovered(groups, discovered) {
    const out = new Map(groups.map((g) => [g.id, g]));
    for (const item of discovered) {
      const id = String(item?.id || "").trim();
      if (!T()?.isThreadId?.(id)) continue;
      const title = T()?.displayTitle?.(item.title, id) || item.title;
      if (!title) continue;
      const prev = out.get(id);
      if (!prev || title.length > prev.title.length) {
        out.set(id, {
          id,
          title,
          kind: T()?.isMeetingId?.(id) ? "meeting" : "chat",
          source: "link",
        });
      }
    }
    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  async function collectGroupsAsync(force = false) {
    const now = Date.now();
    if (!force && cache.length && now - cacheAt < CACHE_MS) {
      return { ok: true, groups: cache, fromDom: 0, fromIdb: 0, cached: true };
    }

    try {
      const dom = readFromDom();
      const urlMap = readFromLocation();
      const headerMap = readFromChatHeader();
      const idbMap = await readFromIdb();
      const activityMatchMap = matchActivityTitlesToIdb(dom, idbMap);
      const groups = merge(dom, urlMap, headerMap, activityMatchMap, idbMap);
      const discovered = await getDiscoveredGroups();
      const merged = mergeDiscovered(groups, discovered);

      cache = merged;
      cacheAt = now;

      const meetings = merged.filter((g) => g.kind === "meeting").length;
      const fromLinks = discovered.length;

      return {
        ok: true,
        groups: merged,
        fromDom: dom.byId.size + urlMap.size + headerMap.size + activityMatchMap.size,
        fromIdb: idbMap.size,
        fromLinks,
        meetings,
        cached: false,
        hint:
          merged.length === 0 && fromLinks === 0
            ? "请打开「聊天/活动」，或点击聊天里的群组链接后自动收录。"
            : fromLinks > 0
              ? "含从聊天链接发现的群组，可在列表中直接打开。"
              : meetings === 0
                ? "若需活动/通话群，请先在「活动」里打开该会话再读取。"
                : "",
      };
    } catch (error) {
      return {
        ok: false,
        groups: [],
        error: error.message || "读取失败",
        hint: "请刷新 Teams 页面后重试。",
      };
    }
  }

  window.TeamsGroups = {
    collectGroupsAsync,
    lookupGroupById,
    lookupGroupByTitle,
    lookupGroupByInviteHint,
  };
})();

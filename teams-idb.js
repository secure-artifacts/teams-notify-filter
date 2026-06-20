/** 从 Teams 客户端 IndexedDB 读取完整会话列表（teams.live.com / v2 更可靠） */
(function () {
  let cachedThreads = [];
  let cachedAt = 0;
  const CACHE_MS = 15000;

  async function findTeamsDbs(prefix) {
    if (typeof indexedDB.databases !== "function") return [];
    try {
      const all = await indexedDB.databases();
      return all
        .filter((d) => d.name && d.name.startsWith(`Teams:${prefix}:`) && d.version)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  function openDbRO(name) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  function readAll(db, storeName) {
    return new Promise((resolve) => {
      try {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve([]);
          return;
        }
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  function titleFromRecord(record) {
    const chatTitle = record?.chatTitle;
    if (chatTitle && typeof chatTitle === "object") {
      for (const v of Object.values(chatTitle)) {
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
    const topic = String(record?.threadProperties?.topic || "").trim();
    if (topic) return topic;
    const lastName =
      record?.lastMessage?.imdisplayname?.trim() ||
      record?.lastMessage?.fromDisplayNameInToken?.trim();
    if (lastName) return lastName;
    return "";
  }

  function chatTypeFromRecord(record) {
    const id = String(record?.id || "");
    const threadType = String(record?.threadProperties?.threadType || record?.type || "").toLowerCase();

    if (id.includes("@oneToOne.skype") || /one.?to.?one|direct|private/i.test(threadType)) {
      return "private";
    }

    if (
      id.includes("@thread") ||
      id.includes("@meet") ||
      /group|space|thread|meet|channel|chat/i.test(threadType)
    ) {
      return "group";
    }

    const title = titleFromRecord(record);
    if (title && /[,，]| and | \+ \d+/i.test(title)) return "group";
    if (title && title.length <= 40) return "private";
    return "group";
  }

  function unreadFromRecord(record) {
    if (record?.threadProperties?.isRead === false) return 1;
    if (record?.threadProperties?.isRead === true) return 0;
    return 0;
  }

  function recordToThread(record) {
    const id = String(record?.id || "").trim();
    if (!id) return null;
    const title = titleFromRecord(record) || id.split("@")[0] || "Teams 会话";
    if (record?.threadProperties?.hidden) return null;
    return {
      id,
      title,
      chatType: chatTypeFromRecord(record),
      unreadCount: unreadFromRecord(record),
      source: "idb",
    };
  }

  async function readConversationList() {
    const dbs = await findTeamsDbs("conversation-manager");
    if (!dbs.length) return [];

    const merged = new Map();
    for (const meta of dbs) {
      const db = await openDbRO(meta.name);
      if (!db) continue;
      try {
        const rows = await readAll(db, "conversations");
        for (const row of rows) {
          if (!row?.id) continue;
          const prev = merged.get(row.id);
          if (!prev || (row.lastMessageTimeUtc || 0) > (prev.lastMessageTimeUtc || 0)) {
            merged.set(row.id, row);
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

    return [...merged.values()]
      .map(recordToThread)
      .filter(Boolean);
  }

  async function refreshIdbThreads(force) {
    const now = Date.now();
    if (!force && cachedThreads.length && now - cachedAt < CACHE_MS) {
      return cachedThreads;
    }
    cachedThreads = await readConversationList();
    cachedAt = now;
    return cachedThreads;
  }

  function getCachedIdbThreads() {
    return cachedThreads;
  }

  window.TeamsNotifyIdb = {
    refreshIdbThreads,
    getCachedIdbThreads,
    readConversationList,
  };
})();

/** 从 Teams 客户端 IndexedDB / sessionStorage 读取完整会话列表 */
(function () {
  let cachedThreads = [];
  let cachedAt = 0;
  const CACHE_MS = 10000;

  async function allDatabases() {
    if (typeof indexedDB.databases !== "function") return [];
    try {
      return await indexedDB.databases();
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
    const topic = String(record?.threadProperties?.topic || record?.topic || "").trim();
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
    if (id.includes("@thread") || id.includes("@meet") || /group|space|thread|meet|channel/i.test(threadType)) {
      return "group";
    }
    const title = titleFromRecord(record);
    if (title && /[,，]| and | \+ \d+/i.test(title)) return "group";
    if (title && title.length <= 40) return "private";
    return "group";
  }

  function unreadFromRecord(record) {
    if (record?.threadProperties?.isRead === false) return 1;
    return 0;
  }

  function recordToThread(record, fallbackTitle) {
    const id = String(record?.id || record?.conversationId || "").trim();
    if (!id || id.length < 4) return null;
    if (record?.threadProperties?.hidden) return null;
    const title = titleFromRecord(record) || fallbackTitle || id.split("@")[0] || "Teams 会话";
    return {
      id,
      title,
      chatType: chatTypeFromRecord(record),
      unreadCount: unreadFromRecord(record),
      source: "idb",
    };
  }

  function readSelfUuid() {
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const m = key?.match(/^tmp\.session\.(.+)-mainWindowNavHistory$/);
        if (m?.[1]) return m[1];
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  function readActiveConversationId() {
    const selfUuid = readSelfUuid();
    if (!selfUuid) return null;
    try {
      const histRaw = sessionStorage.getItem(`tmp.session.${selfUuid}-mainWindowNavHistory`);
      const indexRaw = sessionStorage.getItem(`tmp.session.${selfUuid}-mainWindowNavHistoryIndex`);
      if (!histRaw || !indexRaw) return null;
      const history = JSON.parse(histRaw);
      const index = JSON.parse(indexRaw);
      const i = typeof index.windowHistoryIndex === "number" ? index.windowHistoryIndex : 0;
      const entry = history[i]?.activeEntities?.mainEntity;
      if (entry?.action === "view" && typeof entry.id === "string") return entry.id;
    } catch {
      /* ignore */
    }
    return null;
  }

  async function readFromConversationManager() {
    const merged = new Map();
    const all = await allDatabases();
    const targets = all.filter((d) => d.name && d.name.startsWith("Teams:conversation-manager:"));

    for (const meta of targets) {
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
    return merged;
  }

  async function readFromFolderManager() {
    const titles = new Map();
    const all = await allDatabases();
    const targets = all.filter((d) => d.name && d.name.startsWith("Teams:conversation-folder-manager:"));

    for (const meta of targets) {
      const db = await openDbRO(meta.name);
      if (!db) continue;
      try {
        const folders = await readAll(db, "folders");
        for (const folder of folders) {
          for (const conv of folder?.conversations || []) {
            const id = String(conv?.id || "").trim();
            if (!id) continue;
            titles.set(id, {
              id,
              threadProperties: { threadType: conv.threadType || conv.itemType || "group" },
              type: conv.threadType || conv.itemType,
            });
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
    return titles;
  }

  async function bruteForceScan() {
    const merged = new Map();
    const all = await allDatabases();

    for (const meta of all) {
      if (!meta.name || !/teams/i.test(meta.name)) continue;
      const db = await openDbRO(meta.name);
      if (!db) continue;
      try {
        for (const storeName of db.objectStoreNames) {
          if (!/conversation|chat|thread|folder/i.test(storeName)) continue;
          const rows = await readAll(db, storeName);
          for (const row of rows) {
            if (Array.isArray(row?.conversations)) {
              for (const c of row.conversations) {
                const t = recordToThread(c);
                if (t) merged.set(t.id, t);
              }
              continue;
            }
            const t = recordToThread(row);
            if (t && t.id.includes("@")) merged.set(t.id, t);
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
    return merged;
  }

  async function readConversationList() {
    const records = await readFromConversationManager();
    const folderHints = await readFromFolderManager();

    for (const [id, hint] of folderHints) {
      if (!records.has(id)) records.set(id, hint);
    }

    let threads = [...records.values()].map((r) => recordToThread(r)).filter(Boolean);

    if (threads.length < 2) {
      const brute = await bruteForceScan();
      for (const [id, t] of brute) {
        if (!threads.some((x) => x.id === id)) threads.push(t);
      }
    }

    return threads;
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
    readActiveConversationId,
  };
})();

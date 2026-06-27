/** 解析 /l/invite/ 邀请链接 → 群组 chatId（不打开桌面版） */
(function () {
  if (window !== window.top) return;

  const ID_RE = /19:[a-zA-Z0-9_+\-]+@thread[^\s"'<>]*/gi;
  const INVITE_PATH_RE = /\/l\/invite\/([a-zA-Z0-9._~-]+)/i;
  const RESOLVE_EVENT = "teams-filter-resolve-invite";
  const RESOLVED_EVENT = "teams-filter-invite-resolved";
  const CACHE_KEY = "inviteResolveCache";
  const FETCH_TIMEOUT_MS = 8000;
  const TOTAL_TIMEOUT_MS = 20000;

  function decodeSafe(value) {
    try {
      return decodeURIComponent(String(value || ""));
    } catch {
      return String(value || "");
    }
  }

  function isThreadId(id) {
    return window.TeamsTitles?.isThreadId?.(id) ?? /^19:/.test(String(id || ""));
  }

  function extractThreadIds(text) {
    const hits = String(text || "").match(ID_RE) || [];
    return [...new Set(hits.map((h) => h.trim()).filter(isThreadId))];
  }

  function normalizeInviteUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, location.origin);
      const hashInvite = url.hash.match(/#(?:\/_#?)?\/l\/invite\/([^?&/#]+)([^#]*)?/i);
      if (hashInvite?.[1] && /teams\.(live|microsoft)\.com/i.test(url.hostname)) {
        return `${url.origin}/l/invite/${hashInvite[1]}${hashInvite[2] || ""}`;
      }
      if (!/\/l\/invite\//i.test(url.pathname)) return "";
      url.hash = "";
      return url.toString();
    } catch {
      const hit = text.match(/https?:\/\/teams\.(live|microsoft)\.com\/l\/invite\/[^\s"'<>#]+/i);
      return hit ? hit[0] : "";
    }
  }

  function genUuid() {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {
      /* ignore */
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * teams.live.com：构造 v2 哈希邀请路由，让已登录网页应用以「网页版」模式解析 token、加入并打开群聊。
   * 关键参数 launchType=web / deeplinkId / laExpId / v=*.jlw 来自真实「在网页版继续」流程，
   * 缺少它们会导致只回到 v2 首页或唤起桌面版。
   */
  function toLiveWebInviteUrl(inviteUrl) {
    try {
      const parsed = new URL(inviteUrl);
      if (!/teams\.live\.com/i.test(parsed.hostname)) return inviteUrl;
      const token = parsed.pathname.match(/\/l\/invite\/([^/?#]+)/i)?.[1];
      if (!token) return inviteUrl;
      const vVal = parsed.searchParams.get("v") || "g1";
      const deeplinkId = genUuid();
      const hashQs =
        `v=${encodeURIComponent(vVal)}.jlw` +
        `&launchType=web` +
        `&deeplinkId=${deeplinkId}` +
        `&laExpId=${encodeURIComponent(vVal)}`;
      return `https://teams.live.com/v2/?clientexperience=t2#/l/invite/${token}?${hashQs}`;
    } catch {
      return inviteUrl;
    }
  }

  function isLiveInviteUrl(inviteUrl) {
    return /teams\.live\.com/i.test(String(inviteUrl || ""));
  }

  function inviteToken(inviteUrl) {
    return inviteUrl.match(INVITE_PATH_RE)?.[1] || "";
  }

  function tryDecodeToken(token) {
    if (!token) return "";
    const variants = [token, token.replace(/-/g, "+").replace(/_/g, "/")];
    for (const raw of variants) {
      try {
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        return atob(padded);
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  function pickTitleFromBody(body) {
    return window.TeamsTitles?.pickTitle?.(
      body.match(/"topic"\s*:\s*"([^"]+)"/i)?.[1],
      body.match(/"subject"\s*:\s*"([^"]+)"/i)?.[1],
      body.match(/"chatTitle"\s*:\s*"([^"]+)"/i)?.[1],
      body.match(/"title"\s*:\s*"([^"]+)"/i)?.[1],
      body.match(/property="og:title"\s+content="([^"]+)"/i)?.[1]
    );
  }

  function extractIdFromRedirect(raw) {
    const text = decodeSafe(raw);
    const ids = extractThreadIds(text);
    if (ids[0]) return ids[0];

    const chatPath = text.match(/\/l\/chat\/([^/?#]+)/i);
    if (chatPath?.[1]) {
      const id = decodeSafe(chatPath[1]);
      if (isThreadId(id)) return id;
    }

    const contextMatch = text.match(/[?&]context=([^&"'\s]+)/i);
    if (contextMatch?.[1]) {
      const ctxRaw = decodeSafe(contextMatch[1]);
      try {
        const ctx = JSON.parse(ctxRaw);
        const id = String(ctx?.chatId || ctx?.conversationId || ctx?.threadId || "").trim();
        if (isThreadId(id)) return id;
      } catch {
        const id = extractThreadIds(ctxRaw)[0];
        if (id) return id;
      }
    }

    for (const key of ["chatId", "conversationId", "threadId"]) {
      const hit = text.match(new RegExp(`[?&]${key}=([^&"'\s]+)`, "i"));
      if (!hit?.[1]) continue;
      const id = decodeSafe(hit[1]);
      if (isThreadId(id)) return id;
    }

    return "";
  }

  function extractFromHtml(body) {
    const text = String(body || "");
    const ids = extractThreadIds(text);
    if (ids[0]) return ids[0];

    for (const pattern of [
      /"threadId"\s*:\s*"([^"]+)"/i,
      /"conversationId"\s*:\s*"([^"]+)"/i,
      /"chatId"\s*:\s*"([^"]+)"/i,
    ]) {
      const hit = text.match(pattern);
      const id = String(hit?.[1] || "").trim();
      if (isThreadId(id)) return id;
    }

    const nextData = text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextData?.[1]) {
      const id = extractThreadIds(nextData[1])[0];
      if (id) return id;
    }

    return "";
  }

  function parseApiPayload(text) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }

    const walk = (obj, depth = 0) => {
      if (!obj || depth > 5) return "";
      if (typeof obj === "string") {
        return isThreadId(obj) ? obj : extractThreadIds(obj)[0] || "";
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const hit = walk(item, depth + 1);
          if (hit) return hit;
        }
        return "";
      }
      if (typeof obj !== "object") return "";

      for (const key of ["threadId", "conversationId", "chatId"]) {
        const val = String(obj[key] || "").trim();
        if (isThreadId(val)) return val;
      }

      for (const val of Object.values(obj)) {
        const hit = walk(val, depth + 1);
        if (hit) return hit;
      }
      return "";
    };

    const chatId = String(
      parsed?.threadId ||
        parsed?.conversationId ||
        parsed?.chatId ||
        parsed?.resource?.threadId ||
        parsed?.resource?.conversationId ||
        walk(parsed) ||
        extractThreadIds(text)[0] ||
        ""
    ).trim();

    const title = window.TeamsTitles?.pickTitle?.(
      parsed?.topic,
      parsed?.subject,
      parsed?.title,
      parsed?.chatTitle,
      parsed?.resource?.topic,
      pickTitleFromBody(text)
    );

    return { chatId, title: title || "" };
  }

  function shouldCacheInvites() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ cacheInviteLinks: true }, (data) => {
        resolve(data?.cacheInviteLinks !== false);
        void chrome.runtime.lastError;
      });
    });
  }

  function clearInviteCache() {
    return new Promise((resolve) => {
      chrome.storage.local.remove([CACHE_KEY], () => {
        resolve();
        void chrome.runtime.lastError;
      });
    });
  }

  async function readCache(inviteUrl) {
    if (!(await shouldCacheInvites())) return null;
    return new Promise((resolve) => {
      chrome.storage.local.get({ [CACHE_KEY]: {} }, (data) => {
        const map = data?.[CACHE_KEY] || {};
        resolve(map[inviteUrl] || null);
        void chrome.runtime.lastError;
      });
    });
  }

  async function writeCache(inviteUrl, payload) {
    if (!(await shouldCacheInvites())) return;
    return new Promise((resolve) => {
      chrome.storage.local.get({ [CACHE_KEY]: {} }, (data) => {
        const map = { ...(data?.[CACHE_KEY] || {}), [inviteUrl]: payload };
        const keys = Object.keys(map);
        if (keys.length > 200) {
          for (const key of keys.slice(0, keys.length - 200)) delete map[key];
        }
        chrome.storage.local.set({ [CACHE_KEY]: map }, () => {
          resolve();
          void chrome.runtime.lastError;
        });
      });
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchResolve(inviteUrl) {
    try {
      let current = inviteUrl;
      for (let hop = 0; hop < 8; hop++) {
        const resp = await fetchWithTimeout(current, {
          credentials: "include",
          redirect: "manual",
          headers: { Accept: "text/html,application/json,*/*" },
        });

        const location = resp.headers.get("Location") || resp.headers.get("location") || "";
        if (location) {
          const id = extractIdFromRedirect(location);
          if (id) return { chatId: id, title: "" };

          if (/^msteams:/i.test(location)) {
            const msteamsId = extractIdFromRedirect(location);
            if (msteamsId) return { chatId: msteamsId, title: "" };
            break;
          }

          if (/launcher\.html/i.test(location)) {
            try {
              const launchUrl = new URL(location, current);
              const inner = decodeSafe(launchUrl.searchParams.get("url") || "");
              const innerId = extractIdFromRedirect(inner);
              if (innerId) return { chatId: innerId, title: "" };
            } catch {
              /* ignore */
            }
            // launcher 页本身不含 chatId（个人版需在已登录网页应用内解析），停止跟随
            break;
          }

          try {
            current = new URL(location, current).toString();
            continue;
          } catch {
            break;
          }
        }

        const body = await resp.text();
        const idFromBody = extractFromHtml(body);
        if (idFromBody) return { chatId: idFromBody, title: pickTitleFromBody(body) || "" };
        break;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async function apiFetch(origin, path, options = {}) {
    try {
      const resp = await fetchWithTimeout(origin + path, {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
        ...options,
      });
      if (resp.status >= 500) return null;
      const text = await resp.text();
      const parsed = parseApiPayload(text);
      if (isThreadId(parsed.chatId)) return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }

  async function apiResolve(inviteUrl, token) {
    const origins = [];
    if (/teams\.live\.com/i.test(inviteUrl)) origins.push("https://teams.live.com");
    if (/teams\.microsoft\.com/i.test(inviteUrl)) origins.push("https://teams.microsoft.com");
    if (!origins.length) origins.push(location.origin);

    const getPaths = [
      `/api/messages/v1/conversations/invite/${token}`,
      `/api/v1/me/invites/${token}`,
      `/api/messages/v1/users/me/conversationLinks/${token}`,
    ];

    for (const origin of origins) {
      for (const path of getPaths) {
        const hit = await apiFetch(origin, path, { method: "GET" });
        if (hit?.chatId) return hit;
      }
    }
    return null;
  }

  /** 仅在 GET 解析失败后尝试一次加群（用户已点击邀请链接） */
  async function joinInviteResolve(inviteUrl, token) {
    const origin = /teams\.live\.com/i.test(inviteUrl)
      ? "https://teams.live.com"
      : "https://teams.microsoft.com";

    const attempts = [
      { path: `/api/messages/v1/users/me/conversationLinks`, body: { url: inviteUrl } },
      { path: `/v1/me/invites/${token}/accept`, body: {} },
    ];

    for (const { path, body } of attempts) {
      const hit = await apiFetch(origin, path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (hit?.chatId) return hit;
    }
    return null;
  }

  async function resolveInviteUrl(inviteUrl, hintTitle = "", options = {}) {
    const url = normalizeInviteUrl(inviteUrl);
    if (!url) return null;

    const cached = await readCache(url);
    if (cached?.chatId && isThreadId(cached.chatId)) return cached;

    const token = inviteToken(url);
    const titleHint = String(hintTitle || "").trim();
    const decodedIds = extractThreadIds(tryDecodeToken(token));
    if (decodedIds[0]) {
      const payload = { chatId: decodedIds[0], title: "" };
      await writeCache(url, payload);
      return payload;
    }

    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const timedOut = () => Date.now() > deadline;

    const idbHint = async () => {
      const hit = await window.TeamsGroups?.lookupGroupByInviteHint?.({
        inviteUrl: url,
        title: titleHint,
      });
      if (hit?.id) return { chatId: hit.id, title: hit.title || "" };
      return null;
    };

    // 先查本地（已加入的群，秒开、无需联网）；查不到再用「已登录会话」走网络解析。
    // teams.live.com 也走网络：带 cookie 的 fetch / accept 接口对成员通常能拿到真实 chatId。
    const strategies = [
      idbHint,
      () => fetchResolve(url),
      () => apiResolve(url, token),
      () => (options.allowJoin === true ? joinInviteResolve(url, token) : null),
    ];

    for (const run of strategies) {
      if (timedOut()) break;
      const hit = await run();
      if (hit?.chatId && isThreadId(hit.chatId)) {
        await writeCache(url, hit);
        return hit;
      }
    }

    return null;
  }

  function openInviteInWeb(inviteUrl) {
    const url = normalizeInviteUrl(inviteUrl);
    if (!url) return { ok: false, reason: "invalid-invite" };
    const target = isLiveInviteUrl(url) ? toLiveWebInviteUrl(url) : url;
    try {
      sessionStorage.setItem("teams-filter-invite-pending", url);
      sessionStorage.setItem("teams-filter-invite-auto", "1");
    } catch {
      /* ignore */
    }

    // 若仅 hash 变化（已在 v2 首页），assign 不会重载，应用不会消费 invite 路由；
    // 需强制重载，让 v2 应用启动时以网页版模式解析 token 并打开群聊。
    let onlyHashDiffers = false;
    try {
      const cur = new URL(location.href);
      const tgt = new URL(target);
      onlyHashDiffers =
        cur.origin === tgt.origin &&
        cur.pathname === tgt.pathname &&
        cur.search === tgt.search &&
        cur.hash !== tgt.hash;
    } catch {
      /* ignore */
    }

    window.location.assign(target);
    if (onlyHashDiffers) window.location.reload();
    return { ok: true, method: "web-invite-page", url: target };
  }

  window.addEventListener(RESOLVE_EVENT, async (event) => {
    const inviteUrl = normalizeInviteUrl(event.detail?.inviteUrl);
    const title = String(event.detail?.title || "").trim();
    const clickChatId = String(event.detail?.chatId || "").trim();
    if (!inviteUrl) return;

    // 点击时若已从消息里拿到真实 thread id，直接用它，无需任何网络/解析。
    if (clickChatId && isThreadId(clickChatId)) {
      window.dispatchEvent(
        new CustomEvent(RESOLVED_EVENT, {
          detail: { inviteUrl, title, chatId: clickChatId, resolvedTitle: title },
        })
      );
      return;
    }

    // 用户主动点了邀请链接：允许走 accept 接口（成员幂等，返回会话），以拿到真实 chatId。
    const resolved = await resolveInviteUrl(inviteUrl, title, { allowJoin: true });
    window.dispatchEvent(
      new CustomEvent(RESOLVED_EVENT, {
        detail: {
          inviteUrl,
          title,
          chatId: resolved?.chatId || "",
          resolvedTitle: resolved?.title || "",
        },
      })
    );
  });

  window.TeamsInvite = {
    resolveInviteUrl,
    normalizeInviteUrl,
    clearInviteCache,
    openInviteInWeb,
    toLiveWebInviteUrl,
  };
})();

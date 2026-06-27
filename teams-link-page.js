/** 页面主世界：拦截 Teams 聊天内的群组/邀请链接 */
(function () {
  if (window !== window.top) return;
  if (window.__teamsFilterLinkHandlerInstalled) return;
  window.__teamsFilterLinkHandlerInstalled = true;

  const PANEL_ID = "teams-notify-panel";
  const ID_RE = /19:[a-zA-Z0-9_+\-]+@thread[^\s"'<>]*/gi;
  const OPENED_EVENT = "teams-filter-link-opened";
  const OPEN_CHAT_EVENT = "teams-filter-open-chat";
  const INVITE_EVENT = "teams-filter-resolve-invite";
  const NATIVE_NAV_SELECTORS = [
    '[data-tid="chat-list"]',
    '[data-tid*="chat-list"]',
    '[data-tid*="chat-list-item"]',
    '[data-tid*="left-rail"]',
    '[data-tid*="LeftRail"]',
    '[data-tid*="leftRail"]',
    '[data-tid*="app-bar"]',
    '[data-tid*="nav-bar"]',
    '[data-tid*="activity-feed"]',
    '[data-tid*="activity-list"]',
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

  function isThreadId(id) {
    const t = String(id || "").trim();
    if (!t.startsWith("19:") || !t.includes("@thread")) return false;
    if (t.includes("@oneToOne")) return false;
    if (/\.skype$/i.test(t)) return false;
    return true;
  }

  function decodeSafe(value) {
    try {
      return decodeURIComponent(String(value || ""));
    } catch {
      return String(value || "");
    }
  }

  function isNativeTeamsNav(el) {
    if (!(el instanceof Element)) return false;
    return NATIVE_NAV_SELECTORS.some((sel) => el.closest(sel));
  }

  function isMessageContext(el) {
    if (!(el instanceof Element)) return false;
    return !!el.closest(
      '[data-tid*="message-body"], [data-tid*="messageBody"], [data-tid*="message-content"], [data-tid*="messageContent"]'
    );
  }

  function normalizeInviteUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, rootOrigin());
      if (!/\/l\/invite\//i.test(url.pathname)) return "";
      url.hash = "";
      return url.toString();
    } catch {
      const hit = text.match(/https?:\/\/teams\.(live|microsoft)\.com\/l\/invite\/[^\s"'<>]+/i);
      return hit ? hit[0] : "";
    }
  }

  function inviteFromElement(el) {
    if (!(el instanceof Element)) return "";
    if (el.closest(`#${PANEL_ID}`)) return "";
    if (isNativeTeamsNav(el)) return "";

    if (el.matches("a[href]") || el.closest("a[href]")) {
      const anchor = el.matches("a[href]") ? el : el.closest("a[href]");
      const hit = normalizeInviteUrl(anchor.getAttribute("href") || anchor.href);
      if (hit) return hit;
    }

    if (!isMessageContext(el)) return "";

    for (const attr of ["href", "data-url", "data-href"]) {
      const hit = normalizeInviteUrl(el.getAttribute(attr));
      if (hit) return hit;
    }

    let current = el;
    for (let depth = 0; depth < 10 && current; depth++) {
      for (const attr of current.attributes || []) {
        const hit = normalizeInviteUrl(attr.value);
        if (hit) return hit;
      }
      current = current.parentElement;
    }

    const blob = el.closest('[data-tid*="message"]')?.outerHTML || "";
    if (blob.length < 15000) {
      const hit = blob.match(/https?:\/\/teams\.(live|microsoft)\.com\/l\/invite\/[^\s"'<>]+/i)?.[0];
      if (hit) return hit;
    }
    return "";
  }

  function extractIdFromUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    if (isThreadId(text)) return text;

    try {
      const url = new URL(text, rootOrigin());
      const hostOk = /teams\.(microsoft|live)\.com/i.test(url.hostname);

      const chatPath = url.pathname.match(/\/l\/chat\/([^/]+)/i);
      if (chatPath?.[1]) {
        const id = decodeSafe(chatPath[1]);
        if (isThreadId(id)) return id;
      }

      for (const key of ["chatId", "conversationId", "threadId"]) {
        const param = url.searchParams.get(key);
        if (!param) continue;
        const id = decodeSafe(param);
        if (isThreadId(id)) return id;
      }

      const context = url.searchParams.get("context");
      if (context) {
        try {
          const parsed = JSON.parse(decodeSafe(context));
          const id = String(parsed?.chatId || parsed?.conversationId || "").trim();
          if (isThreadId(id)) return id;
        } catch {
          /* ignore */
        }
      }

      if (!hostOk) {
        const idOnly = text.match(ID_RE)?.[0];
        return idOnly && isThreadId(idOnly) ? idOnly : "";
      }
    } catch {
      /* ignore */
    }

    const hit = text.match(ID_RE)?.[0];
    return hit && isThreadId(hit) ? hit : "";
  }

  function isAppProtocol(href) {
    const text = String(href || "").trim().toLowerCase();
    return text.startsWith("msteams:") || text.startsWith("ms-teams:") || text.includes("ms-teams.exe");
  }

  function hrefFromElement(el) {
    if (!(el instanceof Element)) return "";
    const anchor = el.matches("a[href]") ? el : el.closest("a[href]");
    return anchor?.getAttribute("href") || anchor?.href || "";
  }

  function normalizeTitle(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pickTitle(...candidates) {
    for (const raw of candidates) {
      const t = normalizeTitle(raw);
      if (!t) continue;
      if (/^19:[0-9a-z@._-]+$/i.test(t)) continue;
      if (t.length > 100) continue;
      return t;
    }
    return "";
  }

  function titleFromElement(el) {
    if (!(el instanceof Element)) return "";
    const anchor = el.closest("a[href]") || (el.matches("a[href]") ? el : null);
    const chip = el.closest('[data-tid*="mention"], [data-tid*="link"], [role="link"]') || el;
    return pickTitle(
      anchor?.textContent,
      chip?.textContent,
      chip?.getAttribute("aria-label"),
      el.getAttribute("aria-label"),
      el.getAttribute("title")
    );
  }

  function idFromMessageBlob(el) {
    const scope =
      el.closest('[data-tid*="message-body"], [data-tid*="messageBody"], [data-tid*="message"]') || el;
    if (!(scope instanceof Element)) return "";
    const html = scope.outerHTML || "";
    if (html.length > 12000) return "";
    const hits = html.match(ID_RE) || [];
    for (const hit of hits) {
      if (isThreadId(hit)) return hit;
    }
    return "";
  }

  function idFromElement(el) {
    if (!(el instanceof Element)) return "";
    if (el.closest(`#${PANEL_ID}`)) return "";
    if (isNativeTeamsNav(el)) return "";

    const inMessage = isMessageContext(el);

    if (el.matches("a[href]") || el.closest("a[href]")) {
      const anchor = el.matches("a[href]") ? el : el.closest("a[href]");
      const href = anchor.getAttribute("href") || anchor.href || "";
      const fromHref = extractIdFromUrl(href);
      if (fromHref && (inMessage || /\/l\//i.test(href))) return fromHref;
    }

    if (!inMessage) return "";

    for (const attr of ["data-conversation-id", "data-thread-id", "data-chat-id", "data-id", "itemid", "href"]) {
      const fromAttr = extractIdFromUrl(el.getAttribute(attr));
      if (fromAttr) return fromAttr;
    }

    return idFromMessageBlob(el);
  }

  function resolveLinkClick(event) {
    const path = event.composedPath?.() || [];

    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.closest(`#${PANEL_ID}`)) return null;
      if (isNativeTeamsNav(node)) return null;
    }

    for (const node of path) {
      if (!(node instanceof Element)) continue;

      const href = hrefFromElement(node);
      if (isAppProtocol(href)) {
        return { type: "blocked", href, title: titleFromElement(node), node };
      }

      const inviteUrl = inviteFromElement(node) || normalizeInviteUrl(href);
      if (inviteUrl || /\/l\/invite\//i.test(href)) {
        return {
          type: "invite",
          inviteUrl: inviteUrl || normalizeInviteUrl(href),
          title: titleFromElement(node),
          chatId: idFromMessageBlob(node),
          node,
        };
      }

      if (/\/l\/chat\//i.test(href)) {
        const id = extractIdFromUrl(href);
        if (id) return { type: "chat", id, title: titleFromElement(node), node };
        return { type: "blocked", href, title: titleFromElement(node), node };
      }

      const id = idFromElement(node);
      if (id) return { type: "chat", id, title: titleFromElement(node), node };
    }
    return null;
  }

  function handleInviteOpen(hit) {
    const root = rootWindow();
    root.dispatchEvent(
      new CustomEvent("teams-filter-invite-pending", {
        detail: { inviteUrl: hit.inviteUrl, title: hit.title || "" },
      })
    );
    root.dispatchEvent(
      new CustomEvent(INVITE_EVENT, {
        detail: { inviteUrl: hit.inviteUrl, title: hit.title || "" },
      })
    );
  }

  function handleLinkOpen(hit) {
    const root = rootWindow();
    root.dispatchEvent(
      new CustomEvent(OPENED_EVENT, {
        detail: { id: hit.id, title: hit.title || "" },
      })
    );
    root.dispatchEvent(
      new CustomEvent(OPEN_CHAT_EVENT, {
        detail: { id: hit.id, title: hit.title || "" },
      })
    );
  }

  function onActivate(event, target) {
    if (event.defaultPrevented) return;

    const hit = resolveLinkClick({ composedPath: () => event.composedPath?.() || [target] });
    if (!hit) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (hit.type === "invite") {
      // 消息里直接带真实 thread id（已加入的群）：软跳转，绝不刷新
      if (hit.chatId) {
        handleLinkOpen({ id: hit.chatId, title: hit.title });
        return;
      }
      if (hit.inviteUrl) {
        handleInviteOpen(hit);
      } else {
        rootWindow().dispatchEvent(
          new CustomEvent("teams-filter-invite-failed", {
            detail: { reason: "invalid-invite", title: hit.title || "" },
          })
        );
      }
      return;
    }
    if (hit.type === "blocked") {
      rootWindow().dispatchEvent(
        new CustomEvent("teams-filter-invite-failed", {
          detail: { reason: "blocked-protocol", title: hit.title || "" },
        })
      );
      return;
    }
    handleLinkOpen(hit);
  }

  document.addEventListener(
    "click",
    (event) => {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      onActivate(event, event.target);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof Element)) return;
      onActivate(event, event.target);
    },
    true
  );
})();

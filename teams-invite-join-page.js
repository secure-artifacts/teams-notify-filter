/** 邀请页 / v2#/l/invite：自动加入并跳转网页版聊天（teams.live.com） */
(function () {
  if (window !== window.top) return;
  if (window.__teamsInviteJoinInstalled) return;

  function isInviteContext() {
    if (/\/l\/invite\//i.test(`${location.pathname}${location.hash}`)) return true;
    try {
      return sessionStorage.getItem("teams-filter-invite-auto") === "1";
    } catch {
      return false;
    }
  }

  if (!isInviteContext()) return;
  window.__teamsInviteJoinInstalled = true;

  const ID_RE = /19:[a-zA-Z0-9_+\-]+@thread[^\s"'<>]*/i;

  function isDesktopTarget(url) {
    const text = String(url || "");
    return /^(msteams|ms-teams):/i.test(text) || /msLaunch=true/i.test(text);
  }

  function installDesktopGuards() {
    const originalOpen = window.open;
    window.open = function guardedOpen(url, ...rest) {
      if (isDesktopTarget(url)) return null;
      return originalOpen.call(window, url, ...rest);
    };

    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
        const href = String(target?.getAttribute("href") || "");
        if (!isDesktopTarget(href)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      },
      true
    );
  }

  function chatIdFromText(text) {
    const hit = String(text || "").match(ID_RE);
    if (!hit?.[0] || !hit[0].includes("@thread")) return "";
    if (hit[0].includes("@oneToOne")) return "";
    return hit[0];
  }

  function chatIdFromLocation() {
    try {
      return chatIdFromText(decodeURIComponent(`${location.href}${location.hash}`));
    } catch {
      return chatIdFromText(`${location.href}${location.hash}`);
    }
  }

  // v2 网页应用：SPA 自己用 launchType=web 解析 invite 并打开群聊，
  // 此处不可扫描整页 DOM（聊天列表里全是无关 19:...@thread，会跳错群）。
  function isV2App() {
    return /^\/v2(\/|$)/.test(location.pathname) && !/launcher\.html/i.test(location.pathname);
  }

  function chatIdFromPage() {
    const title = document.title || "";
    const href = location.href || "";
    const body = document.documentElement?.outerHTML || "";
    const haystack = `${href}\n${title}\n${body.slice(0, 250000)}`;
    return chatIdFromText(haystack);
  }

  function liveChatUrl(id) {
    const enc = encodeURIComponent(id);
    return `${location.origin}/v2/?clientexperience=t2&chatId=${enc}`;
  }

  function goToChat(id) {
    try {
      sessionStorage.removeItem("teams-filter-invite-pending");
      sessionStorage.removeItem("teams-filter-invite-auto");
    } catch {
      /* ignore */
    }
    location.replace(/teams\.live\.com/i.test(location.hostname) ? liveChatUrl(id) : `${location.origin}/v2/?chatId=${encodeURIComponent(id)}`);
  }

  const WEB_CONTINUE_RE =
    /(在此浏览器中继续|在此浏览器中打开|改用网页版|继续使用网页版|使用网页版|网页版中打开|continue on this browser|continue in (this |your )?browser|use the web app|open in browser|join on the web|continue on web|use web app instead|在浏览器中继续)/i;
  const JOIN_RE = /(^|\b)(join|加入|open chat|打开聊天|accept|接受|进入群聊|进入)\b/i;

  function fireClick(btn) {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof btn.click === "function") btn.click();
  }

  function findButton(matcher) {
    for (const btn of document.querySelectorAll("button, [role='button'], a")) {
      const href = String(btn.getAttribute("href") || "");
      if (isDesktopTarget(href)) continue;
      const text = String(btn.textContent || btn.getAttribute("aria-label") || btn.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text && matcher.test(text)) return btn;
    }
    return "";
  }

  function clickJoin() {
    // 1) 优先点「在此浏览器中继续 / 改用网页版」，避免再次唤起桌面版
    const webBtn = findButton(WEB_CONTINUE_RE);
    if (webBtn) {
      fireClick(webBtn);
      return true;
    }
    // 2) 其次点「加入 / 打开聊天」等
    const joinBtn = findButton(JOIN_RE);
    if (joinBtn) {
      fireClick(joinBtn);
      return true;
    }
    return false;
  }

  function notifyDone(id) {
    window.dispatchEvent(
      new CustomEvent("teams-filter-invite-joined", {
        detail: { chatId: id, inviteUrl: location.href },
      })
    );
  }

  function tick() {
    if (isV2App()) {
      // 仅信任 URL 中的 chatId（由 SPA 解析后写入）；只记录、不再整页跳转，避免二次刷新与跳错群
      const urlId = chatIdFromLocation();
      if (urlId) {
        notifyDone(urlId);
        return true;
      }
      return false;
    }

    const id = chatIdFromLocation() || chatIdFromPage();
    if (id) {
      notifyDone(id);
      goToChat(id);
      return true;
    }
    clickJoin();
    return false;
  }

  installDesktopGuards();

  if (tick()) return;

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tick() || tries > 100) clearInterval(timer);
  }, 500);

  window.addEventListener("hashchange", () => {
    tick();
  });
})();

/** 顶层 frame：注入链接拦截；teams.live.com 邀请上下文注入自动加入 */
(function () {
  if (window !== window.top) return;

  function isInviteContext() {
    if (/\/l\/invite\//i.test(`${location.pathname}${location.hash}`)) return true;
    try {
      return sessionStorage.getItem("teams-filter-invite-auto") === "1";
    } catch {
      return false;
    }
  }

  function injectScript(file, flag) {
    if (!document.documentElement) {
      setTimeout(() => injectScript(file, flag), 50);
      return;
    }
    if (document.documentElement.dataset[flag] === "1") return;
    document.documentElement.dataset[flag] = "1";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(file);
    script.onload = function onLoad() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  const legacyInvitePath = /\/l\/invite\//i.test(location.pathname);
  const inviteCtx = isInviteContext();

  if (!legacyInvitePath) {
    injectScript("teams-link-page.js", "teamsFilterLinkInjected");
  }
  if (inviteCtx) {
    injectScript("teams-invite-join-page.js", "teamsFilterInviteJoinInjected");
  }
})();

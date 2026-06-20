/**
 * 隔离世界桥接：注入页面脚本并同步配置。
 */
(function () {
  function pushConfig(config) {
    window.dispatchEvent(
      new CustomEvent("teams-notify-config", {
        detail: { enabled: config?.enabled !== false },
      })
    );
  }

  function injectPageScript() {
    if (document.getElementById("teams-notify-guard-page")) return;
    const script = document.createElement("script");
    script.id = "teams-notify-guard-page";
    script.src = chrome.runtime.getURL("notification-guard-page.js");
    script.async = false;
    script.addEventListener("error", () => {
      chrome.runtime.sendMessage({ type: "TEAMS_GUARD_INJECT_FAILED" }, () => {
        void chrome.runtime.lastError;
      });
    });
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  injectPageScript();

  const script = document.getElementById("teams-notify-guard-page");
  if (script) {
    script.addEventListener("load", () => {
      chrome.storage.local.get(["config"], (data) => {
        pushConfig(data?.config);
        void chrome.runtime.lastError;
      });
    });
  }

  chrome.storage.local.get(["config"], (data) => {
    pushConfig(data?.config);
    void chrome.runtime.lastError;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.config) {
      pushConfig(changes.config.newValue);
    }
  });
})();

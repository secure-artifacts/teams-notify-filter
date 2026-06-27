(function () {
  const CONFIG_EVENT = "teams-filter-config";
  const DEFAULT_CONFIG = {
    enabled: true,
    mode: "allow_list",
    keywords: [],
    threads: [],
  };

  function pushConfig(config) {
    window.dispatchEvent(
      new CustomEvent(CONFIG_EVENT, {
        detail: {
          enabled: config.enabled !== false,
          mode: config.mode === "block_list" ? "block_list" : "allow_list",
          keywords: Array.isArray(config.keywords) ? config.keywords : [],
          threads: Array.isArray(config.threads) ? config.threads : [],
        },
      })
    );
  }

  function normalizeThreads(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    for (const item of raw) {
      const id = String(item?.id || "").trim();
      const title = String(item?.title || "").trim();
      if (!id && !title) continue;
      const key = id || `title:${title.toLowerCase()}`;
      map.set(key, { id, title, chatType: "group" });
    }
    return [...map.values()];
  }

  function normalizeConfig(raw) {
    const legacyList = Array.isArray(raw?.blacklist) ? raw.blacklist : [];
    const keywords = Array.isArray(raw?.keywords) ? raw.keywords : legacyList;
    return {
      enabled: raw?.enabled !== false,
      mode: raw?.mode === "block_list" ? "block_list" : "allow_list",
      keywords: keywords.map((item) => String(item || "").trim()).filter(Boolean),
      threads: normalizeThreads(raw?.threads),
    };
  }

  function injectPageScript() {
    if (document.documentElement.dataset.teamsFilterInjected === "1") return;
    document.documentElement.dataset.teamsFilterInjected = "1";

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = function onLoad() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  injectPageScript();

  chrome.storage.sync.get(DEFAULT_CONFIG, (data) => {
    pushConfig(normalizeConfig(data));
    void chrome.runtime.lastError;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!changes.enabled && !changes.mode && !changes.keywords && !changes.blacklist && !changes.threads) return;

    chrome.storage.sync.get(DEFAULT_CONFIG, (data) => {
      pushConfig(normalizeConfig(data));
      void chrome.runtime.lastError;
    });
  });
})();

const enabledEl = document.getElementById("enabled");
const allowedGroupsEl = document.getElementById("allowedGroups");
const openTeamsBtn = document.getElementById("openTeamsBtn");
const monitorStatusEl = document.getElementById("monitorStatus");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

init().catch((error) => setStatus(error.message || "初始化失败", "err"));

saveBtn.addEventListener("click", async () => {
  try {
    const enabled = !!enabledEl.checked;
    const allowedGroups = parseGroupLines(allowedGroupsEl.value);
    await sendMessage("SAVE_CONFIG", { config: { enabled, allowedGroups } });
    setStatus("保存成功", "ok");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message || "保存失败", "err");
  }
});

openTeamsBtn.addEventListener("click", async () => {
  try {
    await sendMessage("OPEN_TEAMS_TAB", { active: true });
    setStatus("已打开 Teams 监听页", "ok");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message || "打开失败", "err");
  }
});

async function init() {
  const res = await sendMessage("GET_CONFIG");
  const config = res.config || {};
  enabledEl.checked = !!config.enabled;
  allowedGroupsEl.value = (config.allowedGroups || []).join("\n");
  await refreshMonitorStatus();
}

async function refreshMonitorStatus() {
  try {
    const res = await sendMessage("GET_MONITOR_STATUS");
    if (!res.enabled) {
      monitorStatusEl.textContent = "插件已关闭";
      return;
    }
    if (!res.hasTab) {
      monitorStatusEl.textContent = "后台监听页未就绪，保存设置后会自动创建";
      return;
    }
    monitorStatusEl.textContent = res.tabActive
      ? "实时监听中（当前正在 Teams 页）"
      : "实时监听中（可切换到其他网页，有新消息立即提醒）";
  } catch (error) {
    monitorStatusEl.textContent = error.message || "无法获取监听状态";
  }
}

function parseGroupLines(text) {
  const seen = new Set();
  const result = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function setStatus(text, type) {
  statusEl.hidden = false;
  statusEl.className = `status ${type || "ok"}`;
  statusEl.textContent = text;
}

function sendMessage(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "请求失败"));
        return;
      }
      resolve(response);
    });
  });
}

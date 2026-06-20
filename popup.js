const enabledEl = document.getElementById("enabled");
const notifyCountEl = document.getElementById("notifyCount");
const openTeamsBtn = document.getElementById("openTeamsBtn");
const monitorStatusEl = document.getElementById("monitorStatus");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

init().catch((error) => setStatus(error.message || "初始化失败", "err"));

saveBtn.addEventListener("click", async () => {
  try {
    const enabled = !!enabledEl.checked;
    await sendMessage("SAVE_CONFIG", { config: { enabled } });
    setStatus("保存成功", "ok");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message || "保存失败", "err");
  }
});

openTeamsBtn.addEventListener("click", async () => {
  openTeamsBtn.disabled = true;
  try {
    await sendMessage("OPEN_TEAMS_TAB", { active: true });
    setStatus("已切换到 Teams 标签页，管理面板会自动打开", "ok");
    await refreshMonitorStatus();
  } catch (error) {
    setStatus(error.message || "打开失败", "err");
  } finally {
    openTeamsBtn.disabled = false;
  }
});

async function init() {
  const res = await sendMessage("GET_CONFIG");
  const config = res.config || {};
  enabledEl.checked = !!config.enabled;
  notifyCountEl.textContent = `通知文件夹：${(config.notifyThreadIds || []).length} 个群组`;
  await refreshMonitorStatus();
}

async function refreshMonitorStatus() {
  try {
    const res = await sendMessage("GET_MONITOR_STATUS");
    notifyCountEl.textContent = `通知文件夹：${res.notifyCount || 0} 个群组`;
    if (!res.enabled) {
      monitorStatusEl.textContent = "插件已关闭";
      return;
    }
    if (!res.hasTab) {
      monitorStatusEl.textContent = "请先在浏览器打开 Teams 页面，再点此按钮切换过去";
      return;
    }
    monitorStatusEl.textContent = res.tabActive
      ? "实时监听中 · 在 Teams 页管理通知文件夹"
      : "实时监听中 · 可切到其他网页";
  } catch (error) {
    monitorStatusEl.textContent = error.message || "无法获取监听状态";
  }
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

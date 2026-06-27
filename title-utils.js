/** 群名与会话 ID 校验（含会议/活动通话 thread） */
(function () {
  const UNNAMED = "未命名群组";

  function normalizeTitle(title) {
    return String(title || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLikelyGarbageTitle(title) {
    const t = normalizeTitle(title);
    if (!t || t === UNNAMED) return !t;
    if (t.length > 100) return true;
    if (/^19:[0-9a-z@._-]+$/i.test(t)) return true;
    if (/^\d+([;,]\d+)+/.test(t)) return true;
    if (/^\d{10,}([;,]\d{10,})*$/.test(t)) return true;
    if (/^[\d;,.\s]+$/.test(t)) return true;
    if ((t.match(/\d/g) || []).length / t.length > 0.6) return true;
    return false;
  }

  function pickTitle(...candidates) {
    for (const raw of candidates) {
      const t = normalizeTitle(raw);
      if (t && !isLikelyGarbageTitle(t)) return t;
    }
    return "";
  }

  function isPrivateId(id) {
    const t = String(id || "");
    return t.includes("@oneToOne") || /\.skype$/i.test(t);
  }

  /** 活动/通话会议 thread：19:meeting_xxx@thread.v2 */
  function isMeetingId(id) {
    return /^19:meeting_/i.test(String(id || "").trim());
  }

  function isIdLikeTitle(title) {
    const t = normalizeTitle(title);
    if (!t) return true;
    if (/^19:[0-9a-z@._-]+$/i.test(t)) return true;
    if (/^19:meeting_/i.test(t)) return true;
    return false;
  }

  /** 普通群聊 + 会议通话 thread（可配置通知） */
  function isThreadId(id) {
    const t = String(id || "").trim();
    if (!t.startsWith("19:") || !t.includes("@thread")) return false;
    return !isPrivateId(t);
  }

  /** @deprecated 使用 isThreadId */
  function isGroupId(id) {
    return isThreadId(id);
  }

  function displayTitle(title, id) {
    const t = pickTitle(title);
    if (!t) return "";
    if (isMeetingId(id)) return t.startsWith("[会议]") ? t : `[会议] ${t}`;
    return t;
  }

  window.TeamsTitles = {
    UNNAMED,
    normalizeTitle,
    isLikelyGarbageTitle,
    pickTitle,
    displayTitle,
    isThreadId,
    isGroupId,
    isPrivateId,
    isMeetingId,
    isIdLikeTitle,
  };
})();

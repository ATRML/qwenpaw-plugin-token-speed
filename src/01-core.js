  // ════════════════════════════════════════════════════════════
  // 01-core.js · 基础常量 / 页面离开标记 / 会话 ID / 结果持久化
  // ════════════════════════════════════════════════════════════
  var BAR_ID = "qp-token-speed-bar";
  var PANEL_ID = "qp-token-speed-detail";
  var DONE = "done";
  var RENDER_MIN_GAP = 250; // running 态最小渲染间隔 ms（高频 delta 节流）
  var SEG_CAP = 200;        // 详情面板保留的分段上限
  // v1.9.0：页面刷新/关闭标记——导航掐死的流不算"出错"，也不覆盖上条结果
  var pageLeaving = false;
  try {
    window.addEventListener("pagehide", function () { pageLeaving = true; });
    window.addEventListener("beforeunload", function () { pageLeaving = true; });
    window.addEventListener("pageshow", function () { pageLeaving = false; });
  } catch (e) { /* 个别环境无 window 事件 */ }

  // 从 URL 提取当前会话 ID（/chat/<uuid>）。v1.13.0：大小写不敏感（评审 P1-3）
  function getSessionId() {
    var m = location.pathname.match(/\/chat\/([^/?#]+)/i);
    if (!m) return "default";
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  // ---------- localStorage 持久化（按会话） ----------
  var LS_KEY = "qp_token_speed_by_session";
  var LS_MAX_SESSIONS = 80;

  function loadLastResult(sid) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      return all[sid || getSessionId()] || null;
    } catch (e) { return null; }
  }
  // ★ 显式传 sid：结果跟着"流所属会话"走，而不是"用户当前看的会话"
  function saveLastResult(sid, r) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      all[sid] = r;
      var keys = Object.keys(all);
      if (keys.length > LS_MAX_SESSIONS) {
        keys.sort(function (a, b) { return (all[a].ts || 0) - (all[b].ts || 0); });
        while (keys.length > LS_MAX_SESSIONS) delete all[keys.shift()];
      }
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

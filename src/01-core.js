  // ════════════════════════════════════════════════════════════
  // 01-core.js · 基础常量 / 页面离开标记 / 会话 ID / 结果持久化 / 会话账本
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

  // v1.20.0 稳定性：解析结果按 raw 字符串做内存缓存。面板开着时 loadLastResult 每 600ms
  // 被调一次，旧版每次重新 JSON.parse 整块（80 会话可达上百 KB）——纯浪费。写入即失效。
  var lsCache = null;
  function readAllResults() {
    try {
      var raw = localStorage.getItem(LS_KEY) || "{}";
      if (lsCache && lsCache.raw === raw) return lsCache.obj;
      var obj = JSON.parse(raw) || {};
      lsCache = { raw: raw, obj: obj };
      return obj;
    } catch (e) { return {}; }
  }
  // v1.20.0 稳定性：配额溢出不再静默丢结果——丢最旧一半重试一次（LS_MAX_SESSIONS 之外的兜底）
  function writeAllResults(all) {
    var raw = JSON.stringify(all);
    try {
      localStorage.setItem(LS_KEY, raw);
    } catch (e) {
      try {
        var keys = Object.keys(all);
        keys.sort(function (a, b) { return (all[a].ts || 0) - (all[b].ts || 0); });
        var drop = Math.ceil(keys.length / 2);
        for (var i = 0; i < drop; i++) delete all[keys[i]];
        raw = JSON.stringify(all);
        localStorage.setItem(LS_KEY, raw);
      } catch (e2) { return false; }
    }
    lsCache = { raw: raw, obj: all };
    return true;
  }

  function loadLastResult(sid) {
    var all = readAllResults();
    return all[sid || getSessionId()] || null;
  }
  // ★ 显式传 sid：结果跟着"流所属会话"走，而不是"用户当前看的会话"
  function saveLastResult(sid, r) {
    var all = readAllResults();
    all[sid] = r;
    var keys = Object.keys(all);
    if (keys.length > LS_MAX_SESSIONS) {
      keys.sort(function (a, b) { return (all[a].ts || 0) - (all[b].ts || 0); });
      while (keys.length > LS_MAX_SESSIONS) delete all[keys.shift()];
    }
    writeAllResults(all);
  }

  // ---------- v1.20.0 会话账本：近期回合滚动流水（面板"今日消耗"聚合的数据源） ----------
  // 设计：只存聚合需要的最小字段（不存分段/全文），300 条上限 ≈ 几十 KB；
  // 按 sid+messageId upsert——刷新后历史恢复同一回合不会重复计账，retro 补算就地更新金额。
  var LEDGER_KEY = "qp_token_speed_ledger";
  var LEDGER_MAX = 300;
  function loadLedger() {
    try { var a = JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveLedger(a) {
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(a)); }
    catch (e) {
      try { localStorage.setItem(LEDGER_KEY, JSON.stringify(a.slice(-Math.floor(LEDGER_MAX / 2)))); } catch (e2) { /* ignore */ }
    }
  }
  function ledgerEntryOf(sid, r) {
    return {
      ts: r.ts || Date.now(), sid: sid || "", mid: r.turnKey || r.messageId || "",
      model: r.model || "", channel: r.channel || "", out: r.outputTokens || 0,
      credits: r.costUnit === "credits" ? r.cost : null,
      cny: r.costUnit === "cny" ? r.cost : null,
      plan: r.afp != null ? r.afp : null
    };
  }
  function appendLedger(sid, r) {
    if (!r || !(r.outputTokens > 0)) return; // 零产出的错误/刷新中止不入账
    var a = loadLedger();
    // turnKey（后端 original_id）优先：历史恢复的 display message.id 每次 fetch 都变，
    // 用它去重会把同一回合重复计账；实测回合的 messageId 是后端稳定 ID
    var key = (sid || "") + "|" + (r.turnKey || r.messageId || ("ts:" + (r.ts || 0)));
    var hit = -1;
    for (var i = a.length - 1; i >= 0; i--) {
      var k = (a[i].sid || "") + "|" + (a[i].mid || ("ts:" + (a[i].ts || 0)));
      if (k === key) { hit = i; break; }
    }
    var e = ledgerEntryOf(sid, r);
    if (hit >= 0) a[hit] = e; else a.push(e);
    if (a.length > LEDGER_MAX) a = a.slice(a.length - LEDGER_MAX);
    saveLedger(a);
  }
  // 今日聚合（本地零点起）：{turns, out, credits, cny, plan, byModel}
  function ledgerToday() {
    var d = new Date(); d.setHours(0, 0, 0, 0);
    var start = d.getTime();
    var a = loadLedger();
    var sum = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0, byModel: {} };
    for (var i = 0; i < a.length; i++) {
      var e = a[i];
      if (!e || (e.ts || 0) < start) continue;
      sum.turns++; sum.out += e.out || 0;
      if (e.credits != null) sum.credits += e.credits;
      if (e.cny != null) sum.cny += e.cny;
      if (e.plan != null) sum.plan += e.plan;
      var mk = e.model || "未知";
      var bm = sum.byModel[mk] || (sum.byModel[mk] = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0 });
      bm.turns++; bm.out += e.out || 0;
      if (e.credits != null) bm.credits += e.credits;
      if (e.cny != null) bm.cny += e.cny;
      if (e.plan != null) bm.plan += e.plan;
    }
    return sum;
  }
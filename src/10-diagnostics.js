  // ════════════════════════════════════════════════════════════
  // 10-diagnostics.js · 调试与事件普查（debugLogEvent / census，不落正文）
  // ════════════════════════════════════════════════════════════
  // 调试：记录前 20 个事件的结构（一次性定位"前端改版后帧外壳变了"）
  var DEBUG_KEY = "qp_token_speed_debug";
  var debugCount = 0;
  // v1.7.0：整页会话的"事件类型普查"（每种类型记一次外壳 + 出现次数）。
  // 用途：确认后端到底发不发 replay_end / tool_call / tool_result 这类帧、外壳长什么样
  // —— 这是"语义分段 + 工具参数计入 token"下一步的先决证据（现在只有静态推断）。
  // 只记键名、字符串长度、数组长度与类型，不落任何正文内容。
  var CENSUS_KEY = "qp_token_speed_event_census";
  var census = null;
  var censusTimer = null;
  function flushCensus() {
    if (censusTimer) { clearTimeout(censusTimer); censusTimer = null; }
    if (!census) return;
    try { localStorage.setItem(CENSUS_KEY, JSON.stringify(census)); } catch (e) { /* diagnostics are optional */ }
  }
  function censusShape(o, prefix, out, depth) {
    if (!o || typeof o !== "object" || out.length >= 24 || depth > 2) return;
    var ks = Object.keys(o);
    if (Array.isArray(o)) ks = ks.slice(0, 3);
    for (var i = 0; i < ks.length && out.length < 24; i++) {
      var k = ks[i], v = o[k];
      if (v === null) out.push(prefix + k + ":null");
      else if (typeof v === "string") out.push(prefix + k + ":str(" + v.length + ")");
      else if (typeof v === "number" || typeof v === "boolean") out.push(prefix + k + ":" + typeof v);
      else if (Array.isArray(v)) { out.push(prefix + k + ":arr(" + v.length + ")"); censusShape(v, prefix + k + "[].", out, depth + 1); }
      else { out.push(prefix + k + ":obj"); censusShape(v, prefix + k + ".", out, depth + 1); }
    }
  }
  function censusLog(evt, type) {
    try {
      if (!census) {
        try { census = JSON.parse(localStorage.getItem(CENSUS_KEY) || "{}"); } catch (e2) { census = {}; }
      }
      var rec = census[type];
      if (rec) {
        rec.n++;
      } else {
        var shape = [];
        censusShape(evt, "", shape, 0);
        census[type] = { n: 1, shape: shape, firstTs: Date.now() };
      }
      if (!censusTimer) censusTimer = setTimeout(flushCensus, 1000);
    } catch (e) { /* ignore */ }
  }
  function debugLogEvent(evt) {
    var type = evt.type || evt.event || "message";
    censusLog(evt, type); // 普查不受下面 20 条上限限制
    try {
      if (debugCount >= 20) return;
      var saved = [];
      try { saved = JSON.parse(localStorage.getItem(DEBUG_KEY) || "[]"); } catch (e) {}
      var keys = [];
      function collectKeys(o, prefix) {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(function (x, i) { collectKeys(x, prefix + "[" + i + "]"); }); return; }
        Object.keys(o).forEach(function (k) {
          var v = o[k];
          keys.push(prefix + k + (typeof v === "string" ? ":str(" + v.length + ")" : typeof v === "object" ? ":obj" : ":num"));
          if (v && typeof v === "object") collectKeys(v, prefix + k + ".");
        });
      }
      collectKeys(evt, "");
      saved.push({ type: type, keys: keys.slice(0, 40), ts: Date.now() });
      if (saved.length > 40) saved = saved.slice(-40);
      localStorage.setItem(DEBUG_KEY, JSON.stringify(saved));
      debugCount++;
    } catch (e) { /* ignore */ }
  }

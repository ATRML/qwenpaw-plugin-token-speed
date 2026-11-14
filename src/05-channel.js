  // ════════════════════════════════════════════════════════════
  // 05-channel.js · 计费渠道判定（provider 三级证据链 / active_llm / providerMap）
  // ════════════════════════════════════════════════════════════
  // ---------- 计费渠道（v1.8.0） ----------
  // 病根（用户实测反馈："明明用的 DeepSeek，为啥出现 AFP"）：模型名无法决定计费渠道
  // ——deepseek-v4-flash 在火山方舟 Agent Plan（AFP 抵扣）与 DeepSeek 官方（人民币）
  // 都在卖，旧逻辑看名字就判 AFP（还把它写进了 AFP 系数表），于是官方按量的回合被
  // 算成套餐抵扣。渠道必须按 provider 判：
  //   provider_id 含 agentplan / base_url 含 /api/plan/  → afp（方舟套餐抵扣）
  //   provider deepseek / base_url 含 deepseek.com       → deepseek（官方按量，人民币）
  //   其他/拿不到                                        → other（不显示金额，不猜）
  var ACTIVE_LLM_KEY = "qp_token_speed_active_llm";     // {ts, providerId, model}
  var PROVIDER_MAP_KEY = "qp_token_speed_provider_map"; // {ts, map:{providerId: base_url}}
  var ACTIVE_LLM_TTL = 20000;      // 20s：够快跟上模型/渠道切换，又不至于每回合都请求
  var PROVIDER_MAP_TTL = 24 * 3600 * 1000;
  // v1.13.1：批量冲刷说明（峰值/速度里剔除过"一大坨一次性砸进来"时挂在面板提示上）
  var FLUSH_TIP = "本回合出现过「批量冲刷」：单个事件一次 >600 tok，且出现在 >1.2s 静默之后（补发尾巴 / 网关缓冲刷出）。"
    + "这类窗口已从峰值与实时速度中剔除——它们衡量的是「数据砸进来的速度」，不是模型解码速度。";

  var activeLlm = null;   // {ts, providerId, model}
  try {
    var _al = JSON.parse(localStorage.getItem(ACTIVE_LLM_KEY) || "null");
    if (_al && typeof _al === "object") activeLlm = _al;
  } catch (e) { /* ignore */ }
  var providerMap = {};   // providerId -> base_url（只在渠道判定需要时才拉，缓存 24h）

  function providerBaseUrl(pid) {
    if (!pid) return "";
    var hit = providerMap[String(pid).toLowerCase()];
    return hit || "";
  }

  // 渠道判定：只认 provider 证据，拿不到证据返回 ""（而不是默认 AFP——那正是旧 bug）
  function resolveChannel(providerId, baseUrl) {
    var pid = String(providerId || "").toLowerCase();
    var bu = String(baseUrl || "").toLowerCase();
    // 顺序关键：/api/coding 必须在 /api/plan 前判（两者都可能含 "coding" 无关，但 base 不重叠，保险起见先判）
    if (/\/api\/coding(\/|$)/.test(bu) || /coding[_\-]?plan/.test(pid)) return "coding";
    if (/agentplan|agent-plan|agent_plan/.test(pid) || /\/api\/plan\//.test(bu)) return "afp";
    if (pid === "deepseek" || pid.indexOf("deepseek") >= 0 || bu.indexOf("deepseek.com") >= 0) return "deepseek";
    if (pid) return "other";
    return "";
  }

  // 三级证据 → 当前渠道。provHint 是本回合 SSE usage 里的 provider_id（若有）
  function currentChannel(provHint) {
    var model = getCurrentModel();
    var cands = [
      { pid: provHint || "", src: "usage" },
      { pid: (activeLlm && activeLlm.providerId) || "", src: "active" }
    ];
    for (var i = 0; i < cands.length; i++) {
      if (!cands[i].pid) continue;
      var ch = resolveChannel(cands[i].pid, providerBaseUrl(cands[i].pid));
      if (ch) return { channel: ch, provider: cands[i].pid, src: cands[i].src };
    }
    // 兜底：连 provider 都拿不到时，只在模型名足够明确时才敢判（DeepSeek 官方是
    // 本机主流配置）。判不出就留空 → 面板显示"渠道未识别"，绝不显示金额
    if (/deepseek/i.test(String(model || ""))) return { channel: "deepseek", provider: "", src: "model" };
    return { channel: "", provider: "", src: "" };
  }

  // 拉当前活跃模型/渠道（GET /api/models/active；鉴权开启时带上 token 与 agent id）
  function apiHeaders() {
    var h = { "Accept": "application/json" };
    try {
      var t = localStorage.getItem("qwenpaw_auth_token");
      if (t) h["Authorization"] = "Bearer " + t;
      var raw = sessionStorage.getItem("qwenpaw-agent-storage") || localStorage.getItem("qwenpaw-agent-storage");
      if (raw) {
        var j = JSON.parse(raw);
        var aid = j && j.state && j.state.selectedAgent;
        if (aid) h["X-Agent-Id"] = aid;
      }
    } catch (e) { /* ignore */ }
    return h;
  }

  var llmFetching = false;
  function refreshActiveLlm(force) {
    if (typeof fetch !== "function") return;
    if (llmFetching) return;
    var fresh = activeLlm && activeLlm.ts && (Date.now() - activeLlm.ts) < ACTIVE_LLM_TTL;
    if (fresh && !force) return;
    llmFetching = true;
    try {
      fetch("/api/models/active", { headers: apiHeaders() })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          llmFetching = false;
          var llm = j && j.active_llm;
          if (!llm || (!llm.provider_id && !llm.model)) return;
          activeLlm = { ts: Date.now(), providerId: llm.provider_id || "", model: llm.model || "" };
          try { localStorage.setItem(ACTIVE_LLM_KEY, JSON.stringify(activeLlm)); } catch (e) { /* ignore */ }
          maybeLoadProviderMap();  // 渠道不能只靠 provider_id 认时才去拉 base_url
          applyBillingRetro();
        })
        .catch(function () { llmFetching = false; });
    } catch (e) { llmFetching = false; }
  }

  // provider_id 不足以判定渠道（例如自定义 provider，如 "huoshanahent"）时，拉一次
  // /api/models 拿 base_url（1.8MB 大响应，只拉一次，落 localStorage 缓存 24h）
  var mapFetching = false;
  function maybeLoadProviderMap() {
    if (!activeLlm || !activeLlm.providerId) return;
    // provider_id 本身就能定性（方舟套餐 / DeepSeek 官方）就不用去拉 base_url 了；
    // 只有"认不出"的自定义 provider（例如 huoshanahent 这种）才需要 base_url 佐证
    var ch0 = resolveChannel(activeLlm.providerId, "");
    if (ch0 === "afp" || ch0 === "deepseek") return;
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(PROVIDER_MAP_KEY) || "null"); } catch (e) { /* ignore */ }
    if (cached && cached.map && cached.ts && (Date.now() - cached.ts) < PROVIDER_MAP_TTL) {
      providerMap = cached.map;
      return;
    }
    if (mapFetching || typeof fetch !== "function") return;
    mapFetching = true;
    try {
      fetch("/api/models", { headers: apiHeaders() })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          mapFetching = false;
          if (!Array.isArray(j)) return;
          var map = {};
          for (var i = 0; i < j.length; i++) {
            var p = j[i] || {};
            var key = String(p.id || "").toLowerCase();
            if (key) map[key] = p.base_url || "";
          }
          providerMap = map;
          try { localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify({ ts: Date.now(), map: map })); } catch (e) { /* ignore */ }
          applyBillingRetro(true); // base_url 证据刚到位：允许 other → afp/deepseek 的升级
        })
        .catch(function () { mapFetching = false; });
    } catch (e) { mapFetching = false; }
  }

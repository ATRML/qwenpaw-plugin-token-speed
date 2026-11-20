/**
 * QwenPaw 插件：Token 实时速度 v2.0.0（前端核心，esbuild 打包）
 * 拦截聊天 SSE 流（POST /api/console/chat），统计 TTFT / 实时速度 / 本轮总量 / 分项耗时 /
 * 费用（套餐额度 / 人民币 / 阿里云百炼 Token Plan Credits）。悬浮条 + 详情面板，fixed 脱离 React 树。
 * 源码在 src/（ESM），请勿手改 dist/index.js。调价改 src/pricing-data.js。版本史见 CHANGELOG.md。
 * @license MIT
 */
(() => {
  // src/store.js
  var store = {
    pageLeaving: false,
    // 页面刷新/关闭标记：导航掐死的流不算"出错"，也不覆盖上条结果
    streamEpoch: 0,
    // 单调递增流纪元：同一会话停止→立即重发时丢弃旧流的一切事件/收尾
    activeLlm: null,
    // {ts, providerId, model}：/api/models/active 缓存
    providerMap: {},
    // providerId -> base_url（渠道判定需要时才拉，缓存 24h）
    states: {}
    // 每会话一个 state（LRU 上限见 state.js）
  };
  try {
    const raw = JSON.parse(localStorage.getItem("qp_token_speed_active_llm") || "null");
    if (raw && typeof raw === "object") store.activeLlm = raw;
  } catch (e) {
  }
  try {
    window.addEventListener("pagehide", function() {
      store.pageLeaving = true;
    });
    window.addEventListener("beforeunload", function() {
      store.pageLeaving = true;
    });
    window.addEventListener("pageshow", function() {
      store.pageLeaving = false;
    });
  } catch (e) {
  }

  // src/renderer.js
  var renderer = {
    /** @param {any} _view 生成中视图（runningView） */
    renderRunning(_view) {
    },
    /** @param {any} _st 回放中的流状态 */
    renderReplay(_st) {
    },
    /** @param {any} _result 终态结果 */
    renderDone(_result) {
    },
    renderWaiting() {
    },
    /** @param {any} [_forceResult] 强制用这份结果重绘（省略则按签名增量刷新） */
    refreshDetail(_forceResult) {
    },
    refreshBarContent() {
    }
  };

  // src/constants.js
  var BAR_ID = "qp-token-speed-bar";
  var PANEL_ID = "qp-token-speed-detail";
  var DONE = "done";
  var RENDER_MIN_GAP = 250;
  var SEG_CAP = 200;

  // src/pricing-data.js
  var PRICING = {
    // —— 套餐渠道（Agent Plan）：额度 = (输入tok×系数 + 输出tok×系数) / 10000（2026-09-01 起入=出同系数）
    plan: {
      // 基础系数表；数组顺序即匹配优先级：glm-5.3-flash(0.5) 必须排在 glm-5.3(4.5) 前（差 9 倍）
      base: [
        { keys: ["seed-2.0-mini"], coef: 0.25 },
        { keys: ["seed-2.0-lite", "deepseek-v4-flash", "deepseek-v4.1-flash", "glm-5.3-flash", "embedding-vision"], coef: 0.5 },
        { keys: ["seed-2.1-turbo", "seed-evolving", "minimax-m3"], coef: 2.5 },
        { keys: ["kimi-k2.7", "glm-5.2", "glm-5.3", "glm-latest"], coef: 4.5 },
        { keys: ["deepseek-v4-pro"], coef: 5.5 },
        { keys: ["kimi-k3"], coef: 10 }
      ],
      // 限时活动：窗口内优先于基础表；活动结束后官方系数未定 → 不入基础表（届时显示"系数未知"，不猜）
      // 边界为 UTC（北京 -8h）。exact:true = 全字匹配（否则 "auto" 子串可能误伤别的名字）
      promo: [
        { keys: ["deepseek-v4.1-flash"], coef: 0.25, start: Date.UTC(2026, 8, 14, 16, 0, 0), end: Date.UTC(2026, 8, 28, 16, 0, 0), label: "\u9650\u65F6\u4E94\u6298\uFF089/15\u20139/28\uFF09" },
        { keys: ["auto"], exact: true, coef: 0.5, start: Date.UTC(2026, 5, 10, 10, 0, 0), end: Date.UTC(2026, 10, 8, 16, 0, 0), label: "Auto \u6D3B\u52A8\u4EF7\uFF086/10\u201311/8\uFF09" }
      ]
    },
    // —— DeepSeek 官方按量（人民币）。只有对拍过的模型才入表，其余不显示金额（不猜）
    deepseek: {
      models: [
        { keys: ["flash"], table: { offPeak: { cacheHit: 0.02, input: 1, output: 4 }, peak: { cacheHit: 0.04, input: 2, output: 8 } } }
      ],
      // 高峰时段（本地时间，24h 制，闭开区间）：工作日 9-12 / 14-18 / 20-23，周末全天低谷
      peakHours: [[9, 12], [14, 18], [20, 23]],
      weekendOffPeak: true
    },
    // —— 路由别名（ark-code-latest = 控制台 Auto）
    alias: {
      keys: ["ark-code-latest", "ark-latest"],
      tip: "ark-code-latest \u662F\u63A7\u5236\u53F0\u7684\u8DEF\u7531\u522B\u540D\uFF0C\u5B9E\u9645\u8D70 Auto \u6A21\u5F0F\uFF1A\u771F\u5B9E\u6A21\u578B\u7531\u63A7\u5236\u53F0\u81EA\u52A8\u8C03\u5EA6\uFF0C\u8BF7\u6C42\u548C\u7528\u91CF\u91CC\u53EA\u5E26\u8FD9\u4E2A\u522B\u540D\u3002Auto \u5728\u6D3B\u52A8\u671F\uFF082026-06-10\uFF5E11-08\uFF09\u56FA\u5B9A\u6309\u7CFB\u6570 0.5 \u62B5\u6263\uFF0C\u4E0E\u5E95\u5C42\u8DEF\u7531\u5230\u54EA\u4E2A\u6A21\u578B\u65E0\u5173\uFF1B\u6D3B\u52A8\u7ED3\u675F\u540E\u5B98\u65B9\u7CFB\u6570\u672A\u5B9A\uFF0C\u5C4A\u65F6\u63D2\u4EF6\u4F1A\u53EA\u7ED9\u53C2\u8003\u533A\u95F4\u3002\u60F3\u8981\u59CB\u7EC8\u7CBE\u786E\u663E\u793A\uFF0C\u628A\u6A21\u578B\u540D\u5199\u6210\u5177\u4F53\u7684\uFF08\u5982 glm-5.3 / deepseek-v4-flash\uFF09\uFF0C\u522B\u7528\u522B\u540D"
    },
    // —— 泛渠道价表：第三方渠道配了 table 或 coef 就算钱（覆盖层可整体注入）
    generic: { models: [] },
    // —— 自定义渠道映射：resolveChannel 在内置判定后、other 前查这张表
    customChannels: [],
    // ════════════════════════════════════════════════════════════════════
    // 阿里云百炼 Token Plan（credits）与百炼按量（dashscope，人民币）
    //
    // 官方换算（用量与额度页 qwen3.6-plus 对拍示例实证）：
    //   输入 8349 tok → 1.67 credits  ⇒ 2 credits/万tok
    //   缓存 40794 tok → 0.82 credits ⇒ 0.2 credits/万tok
    //   输出 573 tok → 0.69 credits   ⇒ 12 credits/万tok
    // 即 credits/万tok 的数值 = 刊例价 元/百万tok 的数值（1 credit = 0.01 元刊例价）。
    // 因此 tiers 里的 input/output/cacheHit 直接填百炼模型价格页（华北2北京）刊例价数字。
    //
    // 结构：{ keys, exact?, tiers:[{upTo, input, output, cacheHit?}], night?, preview?, bailianPeak?, assumedBase? }
    //   tiers     按"单次请求输入 token 数"阶梯计价；upTo=Infinity 表示不分阶梯。
    //             cacheHit 缺省 = 官方未公布缓存单价 → 缓存部分按输入价估（面板标注）。
    //   night     Token Plan 官方夜间折扣（北京 22:00–次日 08:00，整单 credits 乘系数）。
    //             对拍洞察：deepseek 系 5 折 × 忙时刊例价 恰等于其闲时刊例价，故 base 填忙时价 + night:0.5 自洽。
    //   preview   qwen4-max-preview 预览期官方 2 折，夜间再 4 折（官方明示叠加后 0.8 折）。
    //             预览版无独立刊例价，按 qwen4-max 刊例价计（assumedBase 标注）。
    //   bailianPeak  百炼按量渠道（dashscope）专用：该模型按忙/闲时计价（忙 08:00–22:00 北京），
    //             闲时价 = 忙时价 × night。Token Plan 渠道不受此标记影响。
    //   assumedBase  刊例价为同系推断（仅预览版），面板会标注"估算"。
    // 数组顺序 = 匹配优先级：长名/带后缀的排前面。未入表的模型 → 不显示金额（不猜）。
    // ════════════════════════════════════════════════════════════════════
    tokenplan: {
      models: [
        {
          keys: ["qwen4-max-preview", "qwen4.0-max-preview"],
          assumedBase: true,
          tiers: [{ upTo: Infinity, input: 10, output: 30, cacheHit: 0.5 }],
          preview: { start: Date.UTC(2026, 10, 11, 2, 0, 0), end: Date.UTC(2026, 10, 25, 16, 0, 0), factor: 0.2 },
          night: 0.4
        },
        { keys: ["qwen4-max"], tiers: [{ upTo: Infinity, input: 10, output: 30, cacheHit: 0.5 }] },
        { keys: ["qwen3.8-max"], tiers: [{ upTo: Infinity, input: 12, output: 36, cacheHit: 1.5 }], night: 0.4 },
        { keys: ["qwen3.8-flash"], tiers: [{ upTo: Infinity, input: 0.8, output: 2.7 }], night: 0.4 },
        { keys: ["qwen3.7-max"], tiers: [{ upTo: Infinity, input: 12, output: 36 }] },
        { keys: ["qwen3.7-plus"], tiers: [{ upTo: 256e3, input: 2, output: 8 }, { upTo: Infinity, input: 6, output: 24 }] },
        { keys: ["qwen3.6-plus"], tiers: [{ upTo: 256e3, input: 2, output: 12, cacheHit: 0.2 }, { upTo: Infinity, input: 8, output: 48 }] },
        { keys: ["qwen3.6-flash"], tiers: [{ upTo: 256e3, input: 1.2, output: 7.2 }, { upTo: Infinity, input: 4.8, output: 28.8 }] },
        { keys: ["deepseek-v4.1-flash"], tiers: [{ upTo: Infinity, input: 2, output: 8 }], night: 0.5, bailianPeak: true },
        { keys: ["deepseek-v4-pro-0813"], tiers: [{ upTo: Infinity, input: 9, output: 27 }], night: 0.5, bailianPeak: true },
        { keys: ["deepseek-v4-flash-0731"], tiers: [{ upTo: Infinity, input: 3, output: 9 }], night: 0.5, bailianPeak: true },
        { keys: ["deepseek-v4-pro"], tiers: [{ upTo: Infinity, input: 12, output: 24 }] },
        { keys: ["glm-5.3"], tiers: [{ upTo: Infinity, input: 8, output: 28 }] },
        { keys: ["glm-5.2"], tiers: [{ upTo: Infinity, input: 8, output: 28 }] },
        { keys: ["glm-5.1"], tiers: [{ upTo: 32e3, input: 6, output: 24 }, { upTo: Infinity, input: 8, output: 28 }] },
        { keys: ["glm-5"], tiers: [{ upTo: 32e3, input: 4, output: 18 }, { upTo: Infinity, input: 6, output: 22 }] },
        { keys: ["kimi-k2.7-code"], tiers: [{ upTo: Infinity, input: 6.5, output: 27 }] },
        { keys: ["kimi-k2.6"], tiers: [{ upTo: Infinity, input: 6.5, output: 27, cacheHit: 1.1 }] },
        { keys: ["kimi-k2.5"], tiers: [{ upTo: Infinity, input: 4, output: 21 }] },
        { keys: ["minimax-m2.5"], tiers: [{ upTo: Infinity, input: 2.1, output: 8.4, cacheHit: 0.21 }] }
      ],
      // 官方夜间折扣窗口：北京时间 22:00–次日 08:00（用 UTC+8 换算，与用户本机时区无关）
      nightWindow: [22, 8]
    }
  };
  var TP_PLANS = [
    { id: "lite", name: "Lite", price: 39, quota: 2e4 },
    { id: "essential", name: "Essential", price: 79, quota: 45e3 },
    { id: "standard", name: "Standard", price: 139, quota: 8e4 },
    { id: "pro", name: "Pro", price: 312, quota: 2e5 }
  ];
  (function applyPricingOverlay() {
    var raw = null;
    try {
      raw = localStorage.getItem("qp_token_speed_pricing");
    } catch (e) {
      return;
    }
    if (!raw) return;
    var u = null;
    try {
      u = JSON.parse(raw);
    } catch (e) {
      console.warn("[token-speed] pricing \u8986\u76D6\u5C42\u4E0D\u662F\u5408\u6CD5 JSON\uFF0C\u5DF2\u5FFD\u7565");
      return;
    }
    if (!u || typeof u !== "object") return;
    function entryArr(a) {
      if (Object.prototype.toString.call(a) !== "[object Array]") return false;
      for (var i = 0; i < a.length; i++) {
        if (!a[i] || typeof a[i] !== "object" || Object.prototype.toString.call(a[i].keys) !== "[object Array]") return false;
      }
      return true;
    }
    function promoArr(a) {
      if (!entryArr(a)) return false;
      for (var i = 0; i < a.length; i++) {
        if (typeof a[i].start !== "number" || typeof a[i].end !== "number" || typeof a[i].coef !== "number") return false;
      }
      return true;
    }
    function tpArr(a) {
      if (!entryArr(a)) return false;
      for (var i = 0; i < a.length; i++) {
        var ts = a[i].tiers;
        if (Object.prototype.toString.call(ts) !== "[object Array]" || !ts.length) return false;
        for (var j = 0; j < ts.length; j++) {
          if (!ts[j] || typeof ts[j].input !== "number" || typeof ts[j].output !== "number") return false;
        }
      }
      return true;
    }
    try {
      if (u.plan && entryArr(u.plan.base)) PRICING.plan.base = u.plan.base.concat(PRICING.plan.base);
      if (u.plan && promoArr(u.plan.promo)) PRICING.plan.promo = u.plan.promo.concat(PRICING.plan.promo);
      if (u.afp && entryArr(u.afp.base)) PRICING.plan.base = u.afp.base.concat(PRICING.plan.base);
      if (u.afp && promoArr(u.afp.promo)) PRICING.plan.promo = u.afp.promo.concat(PRICING.plan.promo);
      if (u.deepseek && entryArr(u.deepseek.models)) PRICING.deepseek.models = u.deepseek.models.concat(PRICING.deepseek.models);
      if (u.deepseek && Object.prototype.toString.call(u.deepseek.peakHours) === "[object Array]") PRICING.deepseek.peakHours = u.deepseek.peakHours;
      if (u.deepseek && typeof u.deepseek.weekendOffPeak === "boolean") PRICING.deepseek.weekendOffPeak = u.deepseek.weekendOffPeak;
      if (u.alias && entryArr(u.alias.keys)) PRICING.alias.keys = u.alias.keys.concat(PRICING.alias.keys);
      if (u.generic && entryArr(u.generic.models)) PRICING.generic.models = u.generic.models;
      if (entryArr(u.customChannels)) PRICING.customChannels = u.customChannels;
      if (u.tokenplan && tpArr(u.tokenplan.models)) PRICING.tokenplan.models = u.tokenplan.models.concat(PRICING.tokenplan.models);
    } catch (e) {
      console.warn("[token-speed] pricing \u8986\u76D6\u5C42\u5E94\u7528\u5931\u8D25\uFF0C\u4F7F\u7528\u5185\u7F6E\u4EF7\u76EE", e);
    }
  })();

  // src/pricing.js
  function customChannelOf(pid, bu) {
    if (typeof PRICING === "undefined" || !PRICING.customChannels || !PRICING.customChannels.length) return "";
    var hay = (String(pid || "") + "\n" + String(bu || "")).toLowerCase();
    for (var i = 0; i < PRICING.customChannels.length; i++) {
      var it = PRICING.customChannels[i];
      if (!it || !it.channel) continue;
      var ks = it.keys || [];
      for (var j = 0; j < ks.length; j++) {
        if (ks[j] && hay.indexOf(String(ks[j]).toLowerCase()) >= 0) return String(it.channel);
      }
    }
    return "";
  }
  function planCoef(model) {
    if (!model) return null;
    var m = String(model).toLowerCase();
    var t = Date.now();
    for (var p = 0; p < PRICING.plan.promo.length; p++) {
      if (t < PRICING.plan.promo[p].start || t >= PRICING.plan.promo[p].end) continue;
      for (var pk = 0; pk < PRICING.plan.promo[p].keys.length; pk++) {
        var kp = PRICING.plan.promo[p].keys[pk];
        if (PRICING.plan.promo[p].exact ? m === kp : m.indexOf(kp) >= 0) return PRICING.plan.promo[p].coef;
      }
    }
    for (var i = 0; i < PRICING.plan.base.length; i++) {
      for (var j = 0; j < PRICING.plan.base[i].keys.length; j++) {
        if (m.indexOf(PRICING.plan.base[i].keys[j]) >= 0) return PRICING.plan.base[i].coef;
      }
    }
    return null;
  }
  var ALIAS_TIP = PRICING.alias.tip;
  function modelBaseName(model) {
    return String(model || "").toLowerCase().replace(/\s*\[\s*1m\s*\]\s*$/g, "").trim();
  }
  function isAliasModel(model) {
    var m = modelBaseName(model);
    for (var i = 0; i < PRICING.alias.keys.length; i++) {
      if (m.indexOf(PRICING.alias.keys[i]) >= 0) return true;
    }
    return false;
  }
  function autoPromoCoef() {
    var t = Date.now();
    for (var p = 0; p < PRICING.plan.promo.length; p++) {
      if (PRICING.plan.promo[p].exact && PRICING.plan.promo[p].keys.indexOf("auto") >= 0 && t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) return PRICING.plan.promo[p].coef;
    }
    return null;
  }
  function planCoefBounds() {
    var lo = null, hi = null, t = Date.now();
    function bump(c) {
      if (c == null) return;
      if (lo == null || c < lo) lo = c;
      if (hi == null || c > hi) hi = c;
    }
    for (var i = 0; i < PRICING.plan.base.length; i++) bump(PRICING.plan.base[i].coef);
    for (var p = 0; p < PRICING.plan.promo.length; p++) {
      if (t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) bump(PRICING.plan.promo[p].coef);
    }
    return { lo: lo == null ? 0.25 : lo, hi: hi == null ? 10 : hi };
  }
  function calcPlan(channel, model, promptTok, completionTok) {
    if (channel === "afp") channel = "plan";
    if (channel !== "plan") return null;
    if (isAliasModel(model)) {
      var ac = autoPromoCoef();
      if (ac == null) return null;
      return ((promptTok || 0) * ac + (completionTok || 0) * ac) / 1e4;
    }
    var c = planCoef(model);
    if (!c) return null;
    return ((promptTok || 0) * c + (completionTok || 0) * c) / 1e4;
  }
  function calcPlanRange(channel, model, promptTok, completionTok) {
    if (channel !== "plan" && channel !== "afp" || !isAliasModel(model)) return null;
    if (autoPromoCoef() != null) return null;
    var b = planCoefBounds(), n = (promptTok || 0) + (completionTok || 0);
    return { lo: n * b.lo / 1e4, hi: n * b.hi / 1e4, coefLo: b.lo, coefHi: b.hi };
  }
  function fmtPlanRange(r) {
    if (!r) return "";
    return fmtPlan(r.lo) + "~" + fmtPlan(r.hi);
  }
  function priceTableFor(model) {
    var m = String(model || "").toLowerCase();
    for (var i = 0; i < PRICING.deepseek.models.length; i++) {
      for (var j = 0; j < PRICING.deepseek.models[i].keys.length; j++) {
        if (m.indexOf(PRICING.deepseek.models[i].keys[j]) >= 0) return PRICING.deepseek.models[i].table;
      }
    }
    return null;
  }
  function isPeakHour(t) {
    var n = /* @__PURE__ */ new Date();
    var h = n.getHours(), wd = n.getDay();
    var ph = t && t.peakHours ? t.peakHours : PRICING.deepseek.peakHours;
    var weekendOff = t && typeof t.weekendOffPeak === "boolean" ? t.weekendOffPeak : PRICING.deepseek.weekendOffPeak;
    if (weekendOff && (wd === 0 || wd === 6)) return false;
    for (var i = 0; i < ph.length; i++) {
      if (h >= ph[i][0] && h < ph[i][1]) return true;
    }
    return false;
  }
  function genericEntryFor(channel, model) {
    var g = PRICING.generic && PRICING.generic.models || [];
    var m = String(model || "").toLowerCase();
    var ch = String(channel || "").toLowerCase();
    var t = Date.now();
    for (var i = 0; i < g.length; i++) {
      var it = g[i];
      if (!it || String(it.channel || "").toLowerCase() !== ch) continue;
      if (it.start != null && t < it.start) continue;
      if (it.end != null && t >= it.end) continue;
      var ks = it.keys || [];
      for (var j = 0; j < ks.length; j++) {
        if (!ks[j]) continue;
        if (it.exact ? m === String(ks[j]).toLowerCase() : m.indexOf(String(ks[j]).toLowerCase()) >= 0) return it;
      }
    }
    return null;
  }
  function beijingHour(t) {
    return new Date((t == null ? Date.now() : t) + 8 * 3600 * 1e3).getUTCHours();
  }
  function tpNightActive(t) {
    var w = PRICING.tokenplan.nightWindow || [22, 8];
    var h = beijingHour(t);
    return w[0] > w[1] ? h >= w[0] || h < w[1] : h >= w[0] && h < w[1];
  }
  function tokenplanEntryFor(model) {
    if (!model) return null;
    var m = String(model).toLowerCase();
    var ms = PRICING.tokenplan.models;
    for (var i = 0; i < ms.length; i++) {
      var ks = ms[i].keys || [];
      for (var j = 0; j < ks.length; j++) {
        if (!ks[j]) continue;
        if (ms[i].exact ? m === String(ks[j]).toLowerCase() : m.indexOf(String(ks[j]).toLowerCase()) >= 0) return ms[i];
      }
    }
    return null;
  }
  function isTokenPlanAuto(model) {
    return modelBaseName(model) === "auto";
  }
  function tpFactor(entry, t) {
    var f = 1, notes = [];
    if (entry.preview && t >= entry.preview.start && t < entry.preview.end) {
      f *= entry.preview.factor;
      notes.push("\u9884\u89C8\u671F " + Math.round(entry.preview.factor * 10) + " \u6298");
    }
    if (entry.night && tpNightActive(t)) {
      f *= entry.night;
      notes.push("\u591C\u95F4 " + (entry.night * 10).toFixed(1).replace(/\.0$/, "") + " \u6298");
    }
    return { factor: f, note: notes.join(" \xB7 ") };
  }
  function tpTier(entry, promptTok) {
    var ts = entry.tiers;
    for (var i = 0; i < ts.length; i++) {
      if ((promptTok || 0) <= ts[i].upTo) return { tier: ts[i], idx: i };
    }
    return { tier: ts[ts.length - 1], idx: ts.length - 1 };
  }
  function tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t) {
    var pt = promptTok || 0, ct = completionTok || 0;
    var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
    var sel = tpTier(entry, pt);
    var tier = sel.tier;
    var cacheRate = tier.cacheHit != null ? tier.cacheHit : tier.input;
    var fac = tpFactor(entry, t);
    var inCr = (pt - hit) * tier.input / 1e4;
    var caCr = hit * cacheRate / 1e4;
    var outCr = ct * tier.output / 1e4;
    return {
      credits: (inCr + caCr + outCr) * fac.factor,
      input: inCr * fac.factor,
      cache: caCr * fac.factor,
      output: outCr * fac.factor,
      factor: fac.factor,
      factorNote: fac.note,
      tierIdx: sel.idx,
      cacheAssumed: tier.cacheHit == null && hit > 0,
      assumedBase: !!entry.assumedBase
    };
  }
  function calcTokenPlan(model, promptTok, completionTok, cacheHitTok, t) {
    if (isTokenPlanAuto(model)) return null;
    var entry = tokenplanEntryFor(model);
    if (!entry) return null;
    return tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t == null ? Date.now() : t);
  }
  function calcTokenPlanRange(model, promptTok, completionTok, cacheHitTok, t) {
    if (!isTokenPlanAuto(model)) return null;
    var ms = PRICING.tokenplan.models, lo = null, hi = null;
    var tt = t == null ? Date.now() : t;
    for (var i = 0; i < ms.length; i++) {
      var c = tpCalcEntry(ms[i], promptTok, completionTok, cacheHitTok, tt).credits;
      if (lo == null || c < lo) lo = c;
      if (hi == null || c > hi) hi = c;
    }
    if (lo == null) return null;
    return { lo, hi };
  }
  function calcDashscope(model, promptTok, completionTok, cacheHitTok, t) {
    var entry = tokenplanEntryFor(model);
    if (!entry) return null;
    var tt = t == null ? Date.now() : t;
    var pt = promptTok || 0, ct = completionTok || 0;
    var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
    var tier = tpTier(entry, pt).tier;
    var f = entry.bailianPeak && tpNightActive(tt) ? entry.night : 1;
    var cacheRate = tier.cacheHit != null ? tier.cacheHit : tier.input;
    return ((pt - hit) * tier.input + hit * cacheRate + ct * tier.output) / 1e6 * f;
  }
  function calcCost(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan";
    if (!ch || ch === "plan") return null;
    if (ch === "tokenplan") {
      var tp = calcTokenPlan(model, promptTok, completionTok, cacheHitTok);
      return tp ? tp.credits : null;
    }
    if (ch === "dashscope") return calcDashscope(model, promptTok, completionTok, cacheHitTok);
    var pt = promptTok || 0, ct = completionTok || 0;
    var t = ch === "deepseek" ? priceTableFor(model) : (genericEntryFor(ch, model) || {}).table;
    if (t && t.offPeak && t.offPeak.input != null && t.offPeak.output != null) {
      var p = t.peak && isPeakHour(t) ? t.peak : t.offPeak;
      var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
      var inPrice = p.cacheHit != null ? p.cacheHit : p.input;
      return hit / 1e6 * inPrice + Math.max(0, pt - hit) / 1e6 * p.input + ct / 1e6 * p.output;
    }
    var e = genericEntryFor(ch, model);
    if (e && e.coef != null) return (pt + ct) * e.coef / 1e4;
    return null;
  }
  function costUnitFor(channel, model) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan";
    if (!ch || ch === "plan") return "";
    if (ch === "deepseek" || ch === "dashscope") return "cny";
    if (ch === "tokenplan") return "credits";
    var e = genericEntryFor(ch, model);
    return e && e.coef != null ? "plan" : "cny";
  }
  function channelHasPriceTable(ch) {
    var c = String(ch || "").toLowerCase();
    if (c === "afp") c = "plan";
    if (!c) return false;
    if (c === "deepseek" || c === "tokenplan" || c === "dashscope") return true;
    if (c === "plan") return false;
    var g = PRICING.generic && PRICING.generic.models || [];
    for (var i = 0; i < g.length; i++) {
      if (g[i] && String(g[i].channel || "").toLowerCase() === c && (g[i].table || g[i].coef != null)) return true;
    }
    return false;
  }
  function moneyFields(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = channel || "";
    var chN = ch === "afp" ? "plan" : ch;
    var cost = calcCost(chN, model, promptTok, completionTok, cacheHitTok);
    var afp = calcPlan(chN, model, promptTok, completionTok);
    var alias = isAliasModel(model);
    var afpRange = calcPlanRange(chN, model, promptTok, completionTok);
    var tp = null, tpRange = null;
    if (chN === "tokenplan") {
      tp = calcTokenPlan(model, promptTok, completionTok, cacheHitTok);
      if (!tp) tpRange = calcTokenPlanRange(model, promptTok, completionTok, cacheHitTok);
    }
    return {
      channel: ch,
      afp,
      cost,
      costUnit: costUnitFor(chN, model),
      aliasModel: alias,
      afpLo: afpRange ? afpRange.lo : null,
      afpHi: afpRange ? afpRange.hi : null,
      // 路由别名：算不出具体值（别名为真且无精确系数）→ 用区间，不再笼统报"系数未知"
      coefRange: !!afpRange,
      // 渠道=套餐但模型不在系数表且不是路由别名 → 面板提示"系数未知"
      coefMissing: chN === "plan" && afp == null && !afpRange,
      // 渠道配过价表但这模型算不出钱 → 面板提示"无价表"（auto 有区间时不算缺）
      priceMissing: channelHasPriceTable(chN) && cost == null && !tpRange,
      provider: store.activeLlm && store.activeLlm.providerId || "",
      // Token Plan 明细（其他渠道为 null，UI 判空渲染）
      tp,
      tpLo: tpRange ? tpRange.lo : null,
      tpHi: tpRange ? tpRange.hi : null,
      tpRange: !!tpRange
    };
  }

  // src/utils.js
  function now() {
    return performance.now();
  }
  function fmtMs(ms) {
    if (!ms) return "-";
    return ms < 1e3 ? ms.toFixed(0) + "ms" : (ms / 1e3).toFixed(2) + "s";
  }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "-";
    return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : Math.round(n).toLocaleString("zh-CN");
  }
  function fmtSpeed(n) {
    if (n == null || !isFinite(n)) return "-";
    return (n > 0 ? "\u2248" : "") + n.toFixed(1);
  }
  function fmtSec(s) {
    if (!s || s < 0) return "-";
    if (s < 60) return s.toFixed(1) + "s";
    return (s / 60).toFixed(1) + "min";
  }
  var warnedOnce = {};
  function warnOnce(key, msg) {
    if (warnedOnce[key]) return;
    warnedOnce[key] = true;
    try {
      console.warn("[token-speed] " + msg);
    } catch (e) {
    }
  }
  function fmtMoney(v, unit) {
    if (v == null || !isFinite(v)) return "-";
    return (unit || "") + (v >= 0.01 ? v.toFixed(4) : v.toFixed(6));
  }
  function fmtPlan(v) {
    if (v == null || !isFinite(v)) return "-";
    return v >= 0.05 ? v.toFixed(2) : v.toFixed(4);
  }
  function fmtCredits(v) {
    if (v == null || !isFinite(v)) return "-";
    if (v >= 1e3) return v.toFixed(1);
    return v >= 0.05 ? v.toFixed(2) : v.toFixed(4);
  }
  function creditsToCny(v) {
    return v == null || !isFinite(v) ? null : v / 100;
  }
  function rebillNote(channel, cacheHitTok, model) {
    if (channel !== "plan" && channel !== "afp") return "";
    var c = planCoef(model);
    if (!c || !cacheHitTok || cacheHitTok <= 0) return "";
    var rebill = cacheHitTok * c / 1e4;
    if (rebill < 0.05) return "";
    return "\uFF08\u7F13\u5B58\u91CD\u8BA1 " + fmtPlan(rebill) + "\uFF09";
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtAge(r) {
    if (!r || typeof r.ts !== "number" || !(r.ts > 0)) return "";
    var age = Date.now() - r.ts;
    if (age <= 10 * 60 * 1e3) return "";
    var m = Math.floor(age / 6e4);
    if (m < 60) return m + "\u5206\u949F\u524D";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "\u5C0F\u65F6\u524D";
    return Math.floor(h / 24) + "\u5929\u524D";
  }

  // src/session.js
  function getSessionId() {
    var m = location.pathname.match(/\/chat\/([^/?#]+)/i);
    if (!m) return "default";
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  // src/state.js
  function createState(sid) {
    return {
      __sid: sid,
      active: false,
      t0: 0,
      tFirst: 0,
      ttft: 0,
      charCount: 0,
      tokenCount: 0,
      estimatedTokens: 0,
      peakMax: 0,
      // 工具调用参数（type:"data" 帧的 data.arguments 分片）单列统计——
      // 后端 completion_tokens 本就含这块（实测约占输出 30%），但不并入正文速度/分段
      toolCharCount: 0,
      toolEstTokens: 0,
      toolTokens: 0,
      // 语义分段用工具边界；epoch 为流纪元（双流竞态丢弃旧流）
      toolPending: false,
      toolStartT: 0,
      epoch: 0,
      toolCalls: /* @__PURE__ */ Object.create(null),
      textSnapshots: /* @__PURE__ */ Object.create(null),
      idleAccountedUntil: 0,
      requestSessionId: "",
      explicitReplay: false,
      replayToolTokens: 0,
      suspended: false,
      originT0: 0,
      originKnown: true,
      messageId: "",
      snapshotFallback: false,
      toolMessageCalls: /* @__PURE__ */ Object.create(null),
      finishedTools: /* @__PURE__ */ Object.create(null),
      modelWaitMs: 0,
      toolResumeAt: 0,
      // 批量冲刷判定 + 诊断（最大单片 / 回放结束原因 / 冲刷计数）
      evWin: [],
      flushPeak: false,
      diagMax: null,
      diagReplayEnd: "",
      diagFlushAfterSilent: 0,
      // 原始峰值（不做冲刷剔除，诊断 + "峰值≥平均"兜底）/ 被跳过的疑似冲刷数
      peakRaw: 0,
      flushSkipped: 0,
      totalTokens: 0,
      promptTokens: 0,
      cacheHitTokens: 0,
      model: "",
      seenFullText: "",
      tLast: 0,
      eventCount: 0,
      segments: [],
      currentSeg: null,
      pauseMs: 0,
      window: [],
      fullText: "",
      finalUsage: null,
      lastTouched: 0,
      lastResult: null,
      // 中途接入（切换/打开对话时的回放补发）识别
      attached: false,
      replayDone: false,
      replayTokens: 0,
      replayLastT: 0,
      replayWin: [],
      probeT0: 0,
      probeTokens: 0,
      probeWin: [],
      liveTokens: 0,
      liveStartT: 0,
      totalGenerated: 0,
      // 面板实时刷新要用的实时速率 / 后端显式回放结束标记
      lastSpeed: 0,
      replayEndSeen: false,
      // 实时速度 sparkline 环形缓冲 [t, speed]（面板头图用，tick 采样，上限 120 点）
      speedHist: [],
      lastSpeedSampleT: 0,
      // 计费渠道与收尾取证
      providerUsage: "",
      // 本回合 SSE usage 里带的 provider_id（最准证据）
      channel: "",
      // plan / deepseek / other / ""（未识别）
      channelSrc: "",
      // usage / active / model / memory（证据强度排序用）
      provider: "",
      // 用于显示的渠道来源（provider_id）
      endCause: "",
      // stream_end / error_frame / read_error / user_stop
      errMsg: "",
      // 异常结束原因（截断保存，hover 可见）
      lastEventAt: 0,
      // 最后一个 SSE 事件时刻（延迟判定 error 帧用）
      pendingError: "",
      // 待判定的流内 error 帧（1.6s 内有新事件就忽略）
      userStopped: false
      // 用户点了停止（POST /console/chat/stop）
    };
  }
  var STATE_MAX = 12;
  function getState(sid) {
    if (!store.states[sid]) store.states[sid] = createState(sid);
    store.states[sid].lastTouched = Date.now();
    return store.states[sid];
  }
  function pruneStates() {
    var keys = Object.keys(store.states);
    if (keys.length <= STATE_MAX) return;
    var removable = keys.filter(function(k) {
      return store.states[k] && !store.states[k].active;
    });
    removable.sort(function(a, b) {
      return (store.states[a].lastTouched || 0) - (store.states[b].lastTouched || 0);
    });
    for (var i = 0; i < removable.length && Object.keys(store.states).length > STATE_MAX; i++) {
      delete store.states[removable[i]];
    }
  }
  function getActiveStream(sid) {
    var st = store.states[sid];
    return st && st.active ? st : null;
  }
  function pushWin(win, t, v) {
    win.push([t, v]);
    while (win.length && t - win[0][0] > 2e3) win.shift();
  }
  function closeCurrentSeg(st, tEnd) {
    if (st.currentSeg && st.currentSeg.tokens > 0) {
      if (st.tLast) st.currentSeg.t1 = st.tLast;
      else if (tEnd != null) st.currentSeg.t1 = tEnd;
      st.segments.push(st.currentSeg);
    }
    st.currentSeg = null;
  }
  function measuredSegTokens(seg) {
    return Math.max(0, seg.tokens - (seg.firstTokens || 0) - (seg.flushTokens || 0));
  }

  // src/tokens.js
  var RATIO_KEY = "qp_token_speed_ratio";
  var RATIO_MAP_KEY = "qp_token_speed_ratio_map";
  var defaultRatio = 1;
  var ratioMap = {};
  try {
    _rm = JSON.parse(localStorage.getItem(RATIO_MAP_KEY) || "null");
    if (_rm && typeof _rm === "object") ratioMap = _rm;
    defaultRatio = parseFloat(localStorage.getItem(RATIO_KEY)) || 1;
  } catch (e) {
  }
  var _rm;
  function ratioFor(model) {
    model = String(model || "").toLowerCase();
    if (model && ratioMap[model]) return ratioMap[model];
    return defaultRatio;
  }
  function calibrateRatio(model, newRatio) {
    var old = model && ratioMap[model] || defaultRatio;
    var v = old * 0.7 + newRatio * 0.3;
    if (model) {
      ratioMap[model] = v;
      try {
        localStorage.setItem(RATIO_MAP_KEY, JSON.stringify(ratioMap));
      } catch (e) {
      }
    } else {
      defaultRatio = v;
      try {
        localStorage.setItem(RATIO_KEY, defaultRatio.toFixed(4));
      } catch (e) {
      }
    }
  }
  function rawEstimate(text) {
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 19968 && code <= 40959) {
        cjk++;
      } else if (code > 32 && code !== 127) {
        other++;
      }
    }
    return cjk + other / 4;
  }
  function estimateTokens(text, model) {
    return rawEstimate(text) * ratioFor(model);
  }
  function extractUsage(obj) {
    if (!obj || typeof obj !== "object") return null;
    var usage = obj.usage || obj.data && obj.data.usage || null;
    var model = obj.model || obj.data && obj.data.model || "";
    if (usage && typeof usage === "object") {
      let count = function(n) {
        return typeof n === "number" && isFinite(n) && n >= 0;
      };
      var pt = usage.prompt_tokens, ct = usage.completion_tokens;
      var exact = obj.type === "turn_usage" && usage.estimated !== true;
      if (pt !== void 0 && !count(pt) || ct !== void 0 && !count(ct)) return null;
      var hit = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : 0;
      var mName = usage.model_name || model || "";
      var prov = typeof usage.provider_id === "string" ? usage.provider_id : "";
      if (count(pt) && count(ct)) {
        var total = count(usage.total_tokens) ? usage.total_tokens : pt + ct;
        if (total < pt + ct) return null;
        hit = count(hit) ? Math.min(hit, pt) : 0;
        return { generated: ct, total, promptTokens: pt, completionTokens: ct, cacheHit: hit, model: mName, provider: prov, exact };
      }
      var it = usage.input_tokens, ot = usage.output_tokens;
      if (count(it) && count(ot)) {
        return { generated: ot, total: it + ot, promptTokens: it, completionTokens: ot, cacheHit: 0, model: mName, provider: prov, exact };
      }
    }
    return null;
  }

  // src/model.js
  function getCurrentModel() {
    if (store.activeLlm && store.activeLlm.model) return store.activeLlm.model;
    return getDomModel();
  }
  function getDomModel() {
    try {
      var el = document.querySelector(
        ".qwenpaw-chat-anywhere-layout-right-header [class*='triggerName'], [class*='triggerName']"
      );
      if (el && el.textContent.trim()) return el.textContent.trim();
      var hdr = document.querySelector(".qwenpaw-chat-anywhere-layout-right-header");
      if (hdr) {
        var m = hdr.textContent.match(/(deepseek[\w.-]*|glm[\w.-]*|gpt[\w.-]*|claude[\w.-]*|qwen[\w.-]*)/i);
        if (m) return m[1];
      }
    } catch (e) {
    }
    return "";
  }
  function extractFullText(data) {
    if (!data || typeof data !== "object") return "";
    var parts = [];
    function collectContent(o) {
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length; i++) collectContent(o[i]);
        return;
      }
      if (o && typeof o === "object") {
        if (typeof o.text === "string") {
          parts.push(o.text);
          return;
        }
        var keys = Object.keys(o);
        for (var j = 0; j < keys.length; j++) {
          if (keys[j] === "text") continue;
          collectContent(o[keys[j]]);
        }
      }
    }
    collectContent(data);
    return parts.join("");
  }

  // src/channel.js
  var ACTIVE_LLM_KEY = "qp_token_speed_active_llm";
  var PROVIDER_MAP_KEY = "qp_token_speed_provider_map";
  var ACTIVE_LLM_TTL = 2e4;
  var PROVIDER_MAP_TTL = 24 * 3600 * 1e3;
  function providerBaseUrl(pid) {
    if (!pid) return "";
    var hit = store.providerMap[String(pid).toLowerCase()];
    return hit || "";
  }
  function resolveChannel(providerId, baseUrl) {
    var pid = String(providerId || "").toLowerCase();
    var bu = String(baseUrl || "").toLowerCase();
    if (/\/api\/coding(\/|$)/.test(bu) || /coding[_\-]?plan/.test(pid)) return "coding";
    if (/agentplan|agent-plan|agent_plan/.test(pid) || /\/api\/plan\//.test(bu)) return "plan";
    if (/token[-_]?plan/.test(pid) || bu.indexOf("token-plan.") >= 0 || bu.indexOf("maas.aliyuncs.com") >= 0) return "tokenplan";
    if (pid === "deepseek" || pid.indexOf("deepseek") >= 0 || bu.indexOf("deepseek.com") >= 0) return "deepseek";
    if (bu.indexOf("coding.dashscope") >= 0) return "coding";
    if (bu.indexOf("dashscope.aliyuncs.com") >= 0 || /dashscope|bailian/.test(pid)) return "dashscope";
    var _cc = customChannelOf(pid, bu);
    if (_cc) return _cc;
    if (pid) return "other";
    return "";
  }
  function currentChannel(provHint) {
    var model = getCurrentModel();
    var cands = [
      { pid: provHint || "", src: "usage" },
      { pid: store.activeLlm && store.activeLlm.providerId || "", src: "active" }
    ];
    for (var i = 0; i < cands.length; i++) {
      if (!cands[i].pid) continue;
      var ch = resolveChannel(cands[i].pid, providerBaseUrl(cands[i].pid));
      if (ch) return { channel: ch, provider: cands[i].pid, src: cands[i].src };
    }
    if (/deepseek/i.test(String(model || ""))) return { channel: "deepseek", provider: "", src: "model" };
    return { channel: "", provider: "", src: "" };
  }
  function apiHeaders() {
    var h = { Accept: "application/json" };
    try {
      var t = localStorage.getItem("qwenpaw_auth_token");
      if (t) h["Authorization"] = "Bearer " + t;
      var raw = sessionStorage.getItem("qwenpaw-agent-storage") || localStorage.getItem("qwenpaw-agent-storage");
      if (raw) {
        var j = JSON.parse(raw);
        var aid = j && j.state && j.state.selectedAgent;
        if (aid) h["X-Agent-Id"] = aid;
      }
    } catch (e) {
    }
    return h;
  }
  var llmFetching = false;
  function refreshActiveLlm(force) {
    if (store.testMode) return;
    if (typeof fetch !== "function") return;
    if (llmFetching) return;
    var fresh = store.activeLlm && store.activeLlm.ts && Date.now() - store.activeLlm.ts < ACTIVE_LLM_TTL;
    if (fresh && !force) return;
    llmFetching = true;
    try {
      fetch("/api/models/active", { headers: apiHeaders() }).then(function(r) {
        return r && r.ok ? r.json() : null;
      }).then(function(j) {
        llmFetching = false;
        var llm = j && j.active_llm;
        if (!llm || !llm.provider_id && !llm.model) return;
        store.activeLlm = { ts: Date.now(), providerId: llm.provider_id || "", model: llm.model || "" };
        try {
          localStorage.setItem(ACTIVE_LLM_KEY, JSON.stringify(store.activeLlm));
        } catch (e) {
        }
        maybeLoadProviderMap();
        applyBillingRetro();
      }).catch(function() {
        llmFetching = false;
      });
    } catch (e) {
      llmFetching = false;
    }
  }
  var mapFetching = false;
  function maybeLoadProviderMap() {
    if (!store.activeLlm || !store.activeLlm.providerId) return;
    var ch0 = resolveChannel(store.activeLlm.providerId, "");
    if (ch0 === "plan" || ch0 === "deepseek" || ch0 === "coding" || ch0 === "tokenplan" || ch0 === "dashscope") return;
    var cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(PROVIDER_MAP_KEY) || "null");
    } catch (e) {
    }
    if (cached && cached.map && cached.ts && Date.now() - cached.ts < PROVIDER_MAP_TTL) {
      store.providerMap = cached.map;
      return;
    }
    if (mapFetching || typeof fetch !== "function") return;
    mapFetching = true;
    try {
      fetch("/api/models", { headers: apiHeaders() }).then(function(r) {
        return r && r.ok ? r.json() : null;
      }).then(function(j) {
        mapFetching = false;
        if (!Array.isArray(j)) return;
        var map = {};
        for (var i = 0; i < j.length; i++) {
          var p = j[i] || {};
          var key = String(p.id || "").toLowerCase();
          if (key) map[key] = p.base_url || "";
        }
        store.providerMap = map;
        try {
          localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify({ ts: Date.now(), map }));
        } catch (e) {
        }
        applyBillingRetro(true);
      }).catch(function() {
        mapFetching = false;
      });
    } catch (e) {
      mapFetching = false;
    }
  }

  // src/diagnostics.js
  var DEBUG_KEY = "qp_token_speed_debug";
  var debugCount = 0;
  var CENSUS_KEY = "qp_token_speed_event_census";
  var census = null;
  var censusTimer = null;
  function flushCensus() {
    if (censusTimer) {
      clearTimeout(censusTimer);
      censusTimer = null;
    }
    if (!census) return;
    try {
      localStorage.setItem(CENSUS_KEY, JSON.stringify(census));
    } catch (e) {
    }
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
      else if (Array.isArray(v)) {
        out.push(prefix + k + ":arr(" + v.length + ")");
        censusShape(v, prefix + k + "[].", out, depth + 1);
      } else {
        out.push(prefix + k + ":obj");
        censusShape(v, prefix + k + ".", out, depth + 1);
      }
    }
  }
  function censusLog(evt, type) {
    try {
      if (!census) {
        try {
          census = JSON.parse(localStorage.getItem(CENSUS_KEY) || "{}");
        } catch (e2) {
          census = {};
        }
      }
      var rec = census[type];
      if (rec) {
        rec.n++;
      } else {
        var shape = [];
        censusShape(evt, "", shape, 0);
        census[type] = { n: 1, shape, firstTs: Date.now() };
      }
      if (!censusTimer) censusTimer = setTimeout(flushCensus, 1e3);
    } catch (e) {
    }
  }
  function debugLogEvent(evt) {
    var type = evt.type || evt.event || "message";
    censusLog(evt, type);
    try {
      let collectKeys = function(o, prefix) {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) {
          o.forEach(function(x, i) {
            collectKeys(x, prefix + "[" + i + "]");
          });
          return;
        }
        Object.keys(o).forEach(function(k) {
          var v = o[k];
          keys.push(prefix + k + (typeof v === "string" ? ":str(" + v.length + ")" : typeof v === "object" ? ":obj" : ":num"));
          if (v && typeof v === "object") collectKeys(v, prefix + k + ".");
        });
      };
      if (debugCount >= 20) return;
      var saved = [];
      try {
        saved = JSON.parse(localStorage.getItem(DEBUG_KEY) || "[]");
      } catch (e) {
      }
      var keys = [];
      collectKeys(evt, "");
      saved.push({ type, keys: keys.slice(0, 40), ts: Date.now() });
      if (saved.length > 40) saved = saved.slice(-40);
      localStorage.setItem(DEBUG_KEY, JSON.stringify(saved));
      debugCount++;
    } catch (e) {
    }
  }

  // src/persistence.js
  var LS_KEY = "qp_token_speed_by_session";
  var LS_MAX_SESSIONS = 80;
  var lsCache = null;
  function readAllResults() {
    try {
      var raw = localStorage.getItem(LS_KEY) || "{}";
      if (lsCache && lsCache.raw === raw) return lsCache.obj;
      var obj = JSON.parse(raw) || {};
      lsCache = { raw, obj };
      return obj;
    } catch (e) {
      return {};
    }
  }
  function writeAllResults(all) {
    var raw = JSON.stringify(all);
    try {
      localStorage.setItem(LS_KEY, raw);
    } catch (e) {
      try {
        var keys = Object.keys(all);
        keys.sort(function(a, b) {
          return (all[a].ts || 0) - (all[b].ts || 0);
        });
        var drop = Math.ceil(keys.length / 2);
        for (var i = 0; i < drop; i++) delete all[keys[i]];
        raw = JSON.stringify(all);
        localStorage.setItem(LS_KEY, raw);
      } catch (e2) {
        return false;
      }
    }
    lsCache = { raw, obj: all };
    return true;
  }
  function loadLastResult(sid) {
    var all = readAllResults();
    return all[sid || getSessionId()] || null;
  }
  function saveLastResult(sid, r) {
    var all = readAllResults();
    all[sid] = r;
    var keys = Object.keys(all);
    if (keys.length > LS_MAX_SESSIONS) {
      keys.sort(function(a, b) {
        return (all[a].ts || 0) - (all[b].ts || 0);
      });
      while (keys.length > LS_MAX_SESSIONS) delete all[keys.shift()];
    }
    writeAllResults(all);
  }

  // src/ledger.js
  var LEDGER_KEY = "qp_token_speed_ledger";
  var LEDGER_MAX = 300;
  function loadLedger() {
    try {
      var a = JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }
  function saveLedger(a) {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(a));
    } catch (e) {
      try {
        localStorage.setItem(LEDGER_KEY, JSON.stringify(a.slice(-Math.floor(LEDGER_MAX / 2))));
      } catch (e2) {
      }
    }
  }
  function ledgerEntryOf(sid, r) {
    return {
      ts: r.ts || Date.now(),
      sid: sid || "",
      mid: r.turnKey || r.messageId || "",
      model: r.model || "",
      channel: r.channel || "",
      out: r.outputTokens || 0,
      credits: r.costUnit === "credits" ? r.cost : null,
      cny: r.costUnit === "cny" ? r.cost : null,
      plan: r.afp != null ? r.afp : null
    };
  }
  function appendLedger(sid, r) {
    if (!r || !(r.outputTokens > 0)) return;
    var a = loadLedger();
    var key = (sid || "") + "|" + (r.turnKey || r.messageId || "ts:" + (r.ts || 0));
    var hit = -1;
    for (var i = a.length - 1; i >= 0; i--) {
      var k = (a[i].sid || "") + "|" + (a[i].mid || "ts:" + (a[i].ts || 0));
      if (k === key) {
        hit = i;
        break;
      }
    }
    var e = ledgerEntryOf(sid, r);
    if (hit >= 0) a[hit] = e;
    else a.push(e);
    if (a.length > LEDGER_MAX) a = a.slice(a.length - LEDGER_MAX);
    saveLedger(a);
  }
  function ledgerToday() {
    var d = /* @__PURE__ */ new Date();
    d.setHours(0, 0, 0, 0);
    var start = d.getTime();
    var a = loadLedger();
    var sum = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0, byModel: {} };
    for (var i = 0; i < a.length; i++) {
      var e = a[i];
      if (!e || (e.ts || 0) < start) continue;
      sum.turns++;
      sum.out += e.out || 0;
      if (e.credits != null) sum.credits += e.credits;
      if (e.cny != null) sum.cny += e.cny;
      if (e.plan != null) sum.plan += e.plan;
      var mk = e.model || "\u672A\u77E5";
      var bm = sum.byModel[mk] || (sum.byModel[mk] = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0 });
      bm.turns++;
      bm.out += e.out || 0;
      if (e.credits != null) bm.credits += e.credits;
      if (e.cny != null) bm.cny += e.cny;
      if (e.plan != null) bm.plan += e.plan;
    }
    return sum;
  }

  // src/metrics.js
  function channelOf(st) {
    if (st && st.providerUsage) {
      var ch = resolveChannel(st.providerUsage, providerBaseUrl(st.providerUsage));
      if (ch) return ch;
    }
    return st && st.channel || "";
  }
  function burnRateOf(channel, model, speed, promptTok) {
    if (!(speed > 0)) return null;
    var ch = String(channel || "");
    if (ch === "tokenplan") {
      var e = tokenplanEntryFor(model);
      if (!e) return null;
      var tier = tpTier(e, promptTok || 0).tier;
      var f = tpFactor(e, Date.now()).factor;
      return { value: speed * tier.output / 1e4 * 60 * f, unit: "credits/min" };
    }
    var outPrice = null;
    if (ch === "deepseek") {
      var t = priceTableFor(model);
      if (t) outPrice = (isPeakHour(t) && t.peak ? t.peak : t.offPeak).output;
    } else if (ch === "dashscope") {
      var de = tokenplanEntryFor(model);
      if (de) outPrice = tpTier(de, promptTok || 0).tier.output * (de.bailianPeak && tpNightActive(Date.now()) ? de.night : 1);
    }
    if (outPrice == null) return null;
    return { value: speed * outPrice / 1e6 * 3600, unit: "\xA5/h" };
  }
  function observedWaitMs(st) {
    return st.pauseMs + (st.toolPending && st.toolStartT && !(st.attached && !st.replayDone) ? Math.max(0, now() - st.toolStartT) : 0);
  }
  function runningView(st, opts) {
    opts = opts || {};
    var _replay = st.attached ? st.replayTokens || 0 : 0;
    var _tool = st.toolTokens || 0;
    var _costTok = st.tokenCount + _tool + _replay;
    var _ch = channelOf(st);
    var _m = moneyFields(_ch, st.model, st.promptTokens, _costTok, st.cacheHitTokens);
    var _speed = typeof opts.speed === "number" ? opts.speed : st.lastSpeed || 0;
    return {
      ttft: st.attached ? 0 : st.ttft,
      speed: _speed,
      model: st.model,
      tokens: _costTok,
      // 已生成 = 回放 + 接入后（总量口径，不含工具参数）
      toolTokens: _tool,
      // 工具参数单列
      attached: st.attached,
      replaying: st.attached && !st.replayDone,
      tokenSource: "estimate",
      outputTokens: _costTok,
      replayTokens: _replay,
      pauseSec: observedWaitMs(st) / 1e3,
      modelWaitSec: (st.modelWaitMs + (st.toolResumeAt ? Math.max(0, now() - st.toolResumeAt) : 0)) / 1e3,
      channel: _ch,
      cost: _m.cost,
      costUnit: _m.costUnit,
      afp: _m.afp,
      afpLo: _m.afpLo,
      afpHi: _m.afpHi,
      coefRange: _m.coefRange,
      // TokenPlan 明细 / auto 区间 / 燃烧率（其他渠道 tp=null，UI 判空）
      tp: _m.tp,
      tpLo: _m.tpLo,
      tpHi: _m.tpHi,
      tpRange: _m.tpRange,
      burnRate: burnRateOf(_ch, st.model, _speed, st.promptTokens)
    };
  }
  function tick(st) {
    var t = st.eventAt || now();
    var lastPoint = st.window[st.window.length - 1];
    if (lastPoint && lastPoint[0] === t) lastPoint[1] = st.tokenCount;
    else pushWin(st.window, t, st.tokenCount);
    var speed = 0;
    if (st.window.length >= 2) {
      var dt = (t - st.window[0][0]) / 1e3;
      var dtok = st.tokenCount - st.window[0][1];
      if (dt > 0.1) speed = dtok / dt;
    }
    var _maxEv = 0;
    var _flushTok = 0;
    var _dtokW = 0, _dtW = 0;
    if (st.window.length >= 2) {
      _dtW = (t - st.window[0][0]) / 1e3;
      _dtokW = st.tokenCount - st.window[0][1];
    }
    for (var _ei = 0; _ei < (st.evWin ? st.evWin.length : 0); _ei++) {
      var ev = st.evWin[_ei];
      if (ev[0] <= (st.window[0] ? st.window[0][0] : t)) continue;
      if (ev[1] > _maxEv) _maxEv = ev[1];
      if (ev[2]) _flushTok += ev[1];
    }
    if (speed > (st.peakRaw || 0)) st.peakRaw = speed;
    if (_flushTok > 0 && _dtW > 0.1) {
      st.flushPeak = true;
      speed = Math.max(0, (_dtokW - _flushTok) / _dtW);
    } else if (_maxEv > 600 && _dtW > 0.1 && _maxEv * 2 > _dtokW) {
      st.flushSkipped = (st.flushSkipped || 0) + 1;
    }
    if (speed > st.peakMax) st.peakMax = speed;
    st.lastSpeed = speed;
    if (t - (st.lastSpeedSampleT || 0) >= 200) {
      st.lastSpeedSampleT = t;
      st.speedHist.push([t, speed]);
      if (st.speedHist.length > 120) st.speedHist.shift();
    }
    if (st.__sid === getSessionId()) {
      renderer.renderRunning(runningView(st));
    }
  }
  function endTurn(status, st, errMsg, endCause) {
    if (!st || !st.active) return;
    st.active = false;
    st.pendingError = "";
    st.lastTouched = Date.now();
    st.errMsg = String(errMsg || "").slice(0, 80);
    st.endCause = endCause || st.endCause || (status === DONE ? "stream_end" : "");
    if (!st.model) st.model = getCurrentModel();
    if (!st.model) {
      var _last = loadLastResult(st.__sid);
      if (_last && _last.model) st.model = _last.model;
    }
    var _ch = currentChannel(st.providerUsage);
    if (!_ch.channel) {
      var _pr = loadLastResult(st.__sid);
      if (_pr && _pr.channel) _ch = { channel: _pr.channel, provider: _pr.provider || "", src: "memory" };
    }
    st.channel = _ch.channel;
    st.channelSrc = _ch.src || "";
    st.provider = _ch.provider || store.activeLlm && store.activeLlm.providerId || "";
    if (!st.channel) {
      warnOnce("channel", "\u62FF\u4E0D\u5230\u8BA1\u8D39\u6E20\u9053\uFF08usage.provider_id \u4E3A\u7A7A\u4E14 /api/models/active \u8BFB\u4E0D\u5230\uFF09\u2192 \u672C\u8F6E\u53EA\u62A5 token\uFF0C\u4E0D\u663E\u793A\u5957\u9910\u62B5\u6263/\u8D39\u7528\u3002\u8FD9\u662F\u523B\u610F\u7684\uFF1A\u6309\u6A21\u578B\u540D\u731C\u4F1A\u628A\u5B98\u65B9\u6309\u91CF\u7B97\u6210\u5957\u9910\u62B5\u6263");
    }
    if (!st.model) warnOnce("model", '\u672A\u80FD\u4ECE SSE / /api/models/active / DOM / \u4F1A\u8BDD\u8BB0\u5FC6\u8BFB\u5230\u6A21\u578B\u540D\uFF08\u8BE6\u60C5\u9762\u677F\u4F1A\u663E\u793A"\u6A21\u578B\u672A\u77E5"\uFF09\u2014\u2014QwenPaw \u524D\u7AEF\u6216\u63A5\u53E3\u53EF\u80FD\u5DF2\u6539\u7248');
    refreshActiveLlm(false);
    var looksCumulative = false;
    var implausible = false;
    var usageOverwrite = false;
    if (st.finalUsage && st.finalUsage.generated >= 0) {
      var _gen = st.finalUsage.generated;
      st.totalTokens = st.finalUsage.total;
      st.totalGenerated = _gen;
      var elapsed0 = (now() - st.t0) / 1e3;
      var pureChat = !st.attached && st.pauseMs < 2e3 && st.segments.length <= 2;
      var _estText = st.tokenCount;
      var _estTool = st.toolTokens;
      var _estAll = _estText + _estTool;
      if (st.attached) {
        var allObserved = _estAll + (st.replayTokens || 0);
        if (allObserved > 0) {
          var attachedScale = _gen / allObserved;
          st.tokenCount *= attachedScale;
          st.toolTokens *= attachedScale;
          st.replayTokens *= attachedScale;
          st.replayToolTokens *= attachedScale;
          usageOverwrite = true;
        }
      } else if (elapsed0 > 0.2 && _gen / elapsed0 > 2e4) {
        implausible = true;
        looksCumulative = true;
      } else if (!st.finalUsage.exact && !pureChat && _gen > _estAll * 2.5 + 30) {
        looksCumulative = true;
      } else {
        if (_estAll > 0) {
          st.toolTokens = _gen * (_estTool / _estAll);
          st.tokenCount = _gen - st.toolTokens;
        } else {
          st.tokenCount = _gen;
        }
        usageOverwrite = true;
      }
    }
    if (!usageOverwrite && !st.tokenCount && st.fullText && !st.attached) {
      st.tokenCount = estimateTokens(st.fullText, st.model);
    }
    if (st.toolPending) {
      if (st.toolStartT) st.pauseMs += Math.max(0, now() - st.toolStartT);
      st.toolPending = false;
      st.toolStartT = 0;
    }
    if (st.toolResumeAt) {
      st.modelWaitMs += Math.max(0, now() - st.toolResumeAt);
      st.toolResumeAt = 0;
    }
    closeCurrentSeg(st);
    var elapsed = (now() - st.t0) / 1e3;
    var genTime = 0;
    for (var si = 0; si < st.segments.length; si++) {
      genTime += Math.max(0, (st.segments[si].t1 - st.segments[si].t0) / 1e3);
    }
    var genSpeed = 0;
    var liveElapsed = st.attached && st.liveStartT ? (now() - st.liveStartT) / 1e3 : elapsed;
    var avg = (st.attached ? liveElapsed : elapsed) > 0.1 ? st.tokenCount / (st.attached ? liveElapsed : elapsed) : 0;
    var peak = st.peakMax || 0;
    if (usageOverwrite && st.segments.length) {
      var segSum = 0;
      for (var si2 = 0; si2 < st.segments.length; si2++) segSum += st.segments[si2].tokens;
      if (segSum > 0) {
        var scale = st.tokenCount / segSum;
        if (isFinite(scale) && scale >= 0) {
          for (var si3 = 0; si3 < st.segments.length; si3++) {
            st.segments[si3].tokens *= scale;
            st.segments[si3].firstTokens = (st.segments[si3].firstTokens || 0) * scale;
            st.segments[si3].flushTokens = (st.segments[si3].flushTokens || 0) * scale;
          }
          peak *= scale;
        }
      }
    }
    var measuredTokens = 0;
    for (var si4 = 0; si4 < st.segments.length; si4++) {
      var sg = st.segments[si4];
      var dur = (sg.t1 - sg.t0) / 1e3;
      if (dur > 0.05) {
        measuredTokens += measuredSegTokens(sg);
        var ss = measuredSegTokens(sg) / dur;
        if (ss > peak) peak = ss;
      }
    }
    genSpeed = genTime > 0.05 ? measuredTokens / genTime : 0;
    if (measuredTokens > 0 && avg > peak) peak = avg;
    var costCompletion = st.finalUsage && st.finalUsage.completionTokens >= 0 && !implausible ? st.finalUsage.completionTokens : st.tokenCount + st.toolTokens + (st.replayTokens || 0);
    var _money = moneyFields(st.channel, st.model, st.promptTokens, costCompletion, st.cacheHitTokens);
    st.lastResult = {
      ts: Date.now(),
      ttft: st.attached ? 0 : st.ttft,
      // 中途接入的首字是回放首包，无意义
      tokens: st.tokenCount,
      outputTokens: costCompletion,
      tokenSource: st.finalUsage && !implausible ? "usage" : "estimate",
      messageId: st.messageId || "",
      originKnown: st.originKnown,
      snapshotFallback: st.snapshotFallback,
      toolTokens: st.toolTokens || 0,
      // 工具调用参数 token（单列，不进正文速度）
      total: st.totalTokens,
      seconds: elapsed,
      genTime,
      genSpeed,
      pauseSec: st.pauseMs / 1e3,
      modelWaitSec: st.modelWaitMs / 1e3,
      segments: st.segments.slice(-SEG_CAP),
      // 全量给详情面板（上限 200 段）
      cacheHit: st.cacheHitTokens || 0,
      cacheMiss: Math.max(0, (st.promptTokens || 0) - (st.cacheHitTokens || 0)),
      // 金额重算要输入/输出两侧的原始口径（渠道证据异步到手后要就地重算）
      promptTokens: st.promptTokens || 0,
      costTokens: costCompletion,
      cost: _money.cost,
      costUnit: _money.costUnit,
      afp: _money.afp,
      channel: _money.channel,
      channelSrc: st.channelSrc || "",
      provider: st.provider || _money.provider,
      coefMissing: _money.coefMissing,
      priceMissing: _money.priceMissing,
      // 路由别名（ark-code-latest）只给区间
      aliasModel: _money.aliasModel,
      afpLo: _money.afpLo,
      afpHi: _money.afpHi,
      coefRange: _money.coefRange,
      // TokenPlan credits 三分量明细 / auto 参考区间（其他渠道为 null）
      tp: _money.tp,
      tpLo: _money.tpLo,
      tpHi: _money.tpHi,
      tpRange: _money.tpRange,
      errMsg: st.errMsg || "",
      endCause: st.endCause || "",
      model: st.model,
      avg,
      peak,
      flushPeak: !!st.flushPeak,
      // 峰值里剔除过批量冲刷
      peakRaw: st.peakRaw || 0,
      // 未剔除冲刷的原始峰值（诊断）
      flushSkipped: st.flushSkipped || 0,
      // 疑似冲刷但按连续流保留的次数
      status,
      // 中途接入口径
      attached: st.attached,
      replayTokens: st.replayTokens,
      totalGenerated: st.totalGenerated || 0,
      liveTokens: st.tokenCount
    };
    if (usageOverwrite && !st.attached && !looksCumulative && st.estimatedTokens > 10 && st.tokenCount > 0) {
      var newRatio = st.tokenCount / st.estimatedTokens;
      if (newRatio > 0.2 && newRatio < 5) {
        calibrateRatio(String(st.model || "").toLowerCase(), newRatio);
      }
    }
    try {
      var _dseg = [];
      for (var _di = 0; _di < st.segments.length; _di++) {
        var _ds = st.segments[_di];
        _dseg.push({
          tok: Math.round(_ds.tokens),
          dur: +((_ds.t1 - _ds.t0) / 1e3).toFixed(1),
          ev: _ds.ev || 0,
          maxEv: Math.round(_ds.maxEv || 0)
        });
      }
      localStorage.setItem("qp_token_speed_diag", JSON.stringify({
        ts: Date.now(),
        model: st.model,
        attached: !!st.attached,
        replayEnd: st.diagReplayEnd || "",
        replayTokens: Math.round(st.replayTokens || 0),
        liveTokens: Math.round(st.liveTokens || 0),
        tokens: Math.round(st.tokenCount || 0),
        toolTokens: Math.round(st.toolTokens || 0),
        peak: Math.round(peak),
        peakRaw: Math.round(st.peakRaw || 0),
        flushPeak: !!st.flushPeak,
        flushSkipped: st.flushSkipped || 0,
        flushAfterSilent: st.diagFlushAfterSilent || 0,
        maxDelta: st.diagMax,
        segs: _dseg
      }));
    } catch (e) {
    }
    if (st.endCause !== "page_refresh") {
      flushCensus();
      saveLastResult(st.__sid, st.lastResult);
      appendLedger(st.__sid, st.lastResult);
      if (st.__sid === getSessionId()) renderer.renderDone(st.lastResult);
    }
    st.fullText = "";
    st.seenFullText = "";
    st.window = [];
    st.segments = [];
    st.textSnapshots = /* @__PURE__ */ Object.create(null);
    st.evWin = [];
    st.probeWin = [];
    st.replayWin = [];
    st.speedHist = [];
  }

  // src/turn.js
  function beginTool(st, callId, t) {
    if (st.finishedTools[callId]) return;
    if (st.toolResumeAt) {
      st.modelWaitMs += Math.max(0, t - st.toolResumeAt);
      st.toolResumeAt = 0;
    }
    if (!st.toolPending) {
      closeCurrentSeg(st, t);
      st.toolPending = true;
      st.toolStartT = st.attached && !st.replayDone ? 0 : t;
      st.window = [];
      st.evWin = [];
      st.lastSpeed = 0;
    }
    st.toolCalls[callId] = true;
  }
  function completeTool(st, callId, t) {
    if (!st.toolCalls[callId]) return;
    delete st.toolCalls[callId];
    st.finishedTools[callId] = true;
    if (Object.keys(st.toolCalls).length) return;
    var replaying = st.attached && !st.replayDone;
    if (!replaying && st.toolStartT) st.pauseMs += Math.max(0, t - st.toolStartT);
    st.toolPending = false;
    st.toolStartT = 0;
    st.tLast = 0;
    st.idleAccountedUntil = 0;
    st.toolResumeAt = replaying ? 0 : t;
  }
  function startTurn(t0, st, epoch, options) {
    options = options || {};
    var continuing = options.reconnect && (st.active || st.suspended);
    var origin = continuing ? st.t0 : t0;
    st.active = true;
    st.suspended = false;
    st.explicitReplay = !!options.reconnect;
    st.replayToolTokens = 0;
    st.originT0 = origin;
    st.originKnown = !options.reconnect || !!continuing;
    st.messageId = "";
    st.snapshotFallback = false;
    st.eventAt = 0;
    st.epoch = epoch || 0;
    st.lastTouched = Date.now();
    st.t0 = typeof origin === "number" ? origin : now();
    st.tFirst = 0;
    st.ttft = 0;
    st.charCount = 0;
    st.tokenCount = 0;
    st.estimatedTokens = 0;
    st.peakMax = 0;
    st.peakRaw = 0;
    st.flushSkipped = 0;
    st.toolCharCount = 0;
    st.toolEstTokens = 0;
    st.toolTokens = 0;
    st.toolPending = false;
    st.toolStartT = 0;
    st.toolCalls = /* @__PURE__ */ Object.create(null);
    st.toolMessageCalls = /* @__PURE__ */ Object.create(null);
    st.finishedTools = /* @__PURE__ */ Object.create(null);
    st.modelWaitMs = 0;
    st.toolResumeAt = 0;
    st.textSnapshots = /* @__PURE__ */ Object.create(null);
    st.idleAccountedUntil = 0;
    st.prevEventAt = 0;
    st.evWin = [];
    st.flushPeak = false;
    st.diagMax = null;
    st.diagReplayEnd = "";
    st.diagFlushAfterSilent = 0;
    st.eventCount = 0;
    st.window = [];
    st.fullText = "";
    st.totalTokens = 0;
    st.tLast = 0;
    st.segments = [];
    st.currentSeg = null;
    st.pauseMs = 0;
    st.promptTokens = 0;
    st.cacheHitTokens = 0;
    st.seenFullText = "";
    st.model = getCurrentModel();
    st.finalUsage = null;
    st.lastResult = null;
    st.attached = !!options.reconnect;
    st.replayDone = !!options.fresh;
    st.replayTokens = 0;
    st.replayLastT = 0;
    st.replayWin = [];
    st.probeT0 = 0;
    st.probeTokens = 0;
    st.probeWin = [];
    st.liveTokens = 0;
    st.liveStartT = 0;
    st.totalGenerated = 0;
    st.lastSpeed = 0;
    st.replayEndSeen = false;
    st.speedHist = [];
    st.lastSpeedSampleT = 0;
    st.providerUsage = "";
    st.endCause = "";
    st.errMsg = "";
    st.pendingError = "";
    st.userStopped = false;
    st.lastEventAt = now();
    var _boot = currentChannel("");
    st.channel = _boot.channel;
    st.channelSrc = _boot.src || "";
    st.provider = _boot.provider || store.activeLlm && store.activeLlm.providerId || "";
    refreshActiveLlm(false);
    if (st.__sid === getSessionId()) {
      if (st.explicitReplay) renderer.renderReplay(st);
      else renderer.renderWaiting();
    }
  }
  function addDelta(text, st, evt) {
    if (!st || !text) return;
    if (st.pendingError) {
      st.pendingError = "";
      st.endCause = "";
    }
    var t = st.eventAt || now();
    var clean = text;
    var key = [
      evt && (evt.msg_id || evt.id) || "",
      evt && (evt.type || evt.object) || "text",
      evt && evt.index != null ? evt.index : 0
    ].join("|");
    var prev = st.textSnapshots[key] || "";
    if (evt && evt.delta === false) {
      clean = text.slice(Math.min(prev.length, text.length));
      st.textSnapshots[key] = text;
      if (clean) st.snapshotFallback = true;
    } else st.textSnapshots[key] = prev + text;
    if (!clean) return;
    if (!st.tFirst) {
      st.tFirst = t;
      st.ttft = t - st.t0;
    }
    var deltaTok = estimateTokens(clean, st.model);
    if (st.explicitReplay && !st.replayDone) {
      st.replayTokens += deltaTok;
      st.replayLastT = t;
      renderer.renderReplay(st);
      return;
    }
    if (!st.diagMax || deltaTok > st.diagMax.tok) {
      st.diagMax = {
        tok: Math.round(deltaTok),
        chars: clean.length,
        at: Math.round(t - st.t0),
        phase: st.replayDone ? "live" : st.attached ? "replay" : "probe"
      };
    }
    st.evWin = st.evWin || [];
    var packet = st.evWin[st.evWin.length - 1];
    if (packet && packet[0] === t) {
      packet[1] += deltaTok;
      if (packet[1] > 600 && packet[3] >= 1200) packet[2] = true;
    } else {
      pushWin(st.evWin, t, deltaTok);
      st.evWin[st.evWin.length - 1][2] = deltaTok > 600 && !!st.tLast && t - st.tLast >= 1200;
      st.evWin[st.evWin.length - 1][3] = st.tLast ? t - st.tLast : 0;
    }
    if (!st.replayDone) {
      if (!st.attached) {
        if (!st.probeT0) st.probeT0 = t;
        st.probeTokens += deltaTok;
        pushWin(st.probeWin, t, st.probeTokens);
        var _age = t - st.probeT0;
        var _wr = 0;
        if (st.probeWin.length >= 2) {
          var _pdt = (t - st.probeWin[0][0]) / 1e3;
          if (_pdt > 0.2) _wr = (st.probeTokens - st.probeWin[0][1]) / _pdt;
        }
        if (deltaTok > 600 || st.probeTokens > 2e4 || _wr > 800 && _age > 3e3) {
          st.attached = true;
          st.diagReplayEnd = "probe_flush";
          st.tokenCount = 0;
          st.estimatedTokens = 0;
          st.charCount = 0;
          st.eventCount = 0;
          st.peakMax = 0;
          st.peakRaw = 0;
          st.flushSkipped = 0;
          st.window = [];
          st.segments = [];
          st.currentSeg = null;
          st.pauseMs = 0;
          st.liveTokens = 0;
          st.liveStartT = 0;
          st.toolCharCount = 0;
          st.toolEstTokens = 0;
          st.toolTokens = 0;
          st.toolPending = false;
          st.toolStartT = 0;
          st.toolCalls = /* @__PURE__ */ Object.create(null);
          st.evWin = [];
          st.tLast = 0;
          st.idleAccountedUntil = 0;
          st.tFirst = t;
          st.ttft = 0;
          st.replayTokens = st.probeTokens;
          st.replayLastT = t;
          st.replayWin = [[t, st.replayTokens]];
          renderer.renderReplay(st);
          return;
        }
        if (_age > 6e3 && _wr <= 800) {
          st.replayDone = true;
          st.diagReplayEnd = "probe_normal";
        }
      }
      if (st.attached) {
        var _silent = st.prevEventAt && t - st.prevEventAt > 1500;
        var _added = false;
        if (!_silent) {
          st.replayTokens += deltaTok;
          _added = true;
          st.replayLastT = t;
          pushWin(st.replayWin, t, st.replayTokens);
          if (st.replayWin.length >= 2) {
            var _rdt = (t - st.replayWin[0][0]) / 1e3;
            if (_rdt > 1.2 && (st.replayTokens - st.replayWin[0][1]) / _rdt < 500) {
              st.replayDone = true;
              st.diagReplayEnd = "rate_low";
            }
          }
          if (!st.replayDone && t - st.t0 > 9e4) {
            st.replayDone = true;
            st.diagReplayEnd = "cap90s";
          }
        } else if (deltaTok > 600) {
          st.replayTokens += deltaTok;
          _added = true;
          st.replayLastT = t;
          pushWin(st.replayWin, t, st.replayTokens);
          st.diagFlushAfterSilent++;
        } else {
          st.replayDone = true;
          st.diagReplayEnd = "silent_small";
        }
        if (!st.replayDone) {
          renderer.renderReplay(st);
          return;
        }
        if (_added) {
          st.replayTokens -= deltaTok;
          st.replayWin.pop();
        }
        st.currentSeg = null;
      }
    }
    if (st.toolPending) {
      closeCurrentSeg(st, t);
      if (st.toolStartT) st.pauseMs += Math.max(0, t - st.toolStartT);
      st.toolPending = false;
      st.toolStartT = 0;
      st.toolCalls = /* @__PURE__ */ Object.create(null);
      st.tLast = 0;
      st.idleAccountedUntil = 0;
    }
    if (st.toolResumeAt) {
      st.modelWaitMs += Math.max(0, t - st.toolResumeAt);
      st.toolResumeAt = 0;
    }
    if (st.tLast && t - st.tLast > 2e3) {
      closeCurrentSeg(st);
      st.pauseMs += Math.max(0, t - Math.max(st.tLast, st.idleAccountedUntil || 0));
      st.idleAccountedUntil = t;
    }
    if (!st.currentSeg) {
      st.window = [];
      st.evWin = [[t, deltaTok, deltaTok > 600 && !!st.tLast && t - st.tLast >= 1200, st.tLast ? t - st.tLast : 0]];
      st.lastSpeed = 0;
      st.currentSeg = { t0: t, t1: t, tokens: 0, firstTokens: deltaTok, flushTokens: 0, ev: 0, maxEv: 0 };
    }
    st.tLast = t;
    st.idleAccountedUntil = 0;
    if (!st.liveStartT) st.liveStartT = t;
    st.liveTokens += deltaTok;
    st.charCount += clean.length;
    st.estimatedTokens += rawEstimate(clean);
    st.tokenCount += deltaTok;
    if (st.currentSeg) {
      if (st.currentSeg.ev > 0 && st.currentSeg.t0 === t) st.currentSeg.firstTokens += deltaTok;
      if (st.currentSeg.ev > 0 && (evt && evt.delta === false || st.evWin.length && st.evWin[st.evWin.length - 1][2])) {
        st.currentSeg.flushTokens += deltaTok;
      }
      st.currentSeg.tokens += deltaTok;
      st.currentSeg.t1 = t;
      st.currentSeg.ev++;
      if (deltaTok > st.currentSeg.maxEv) st.currentSeg.maxEv = deltaTok;
    }
    st.eventCount++;
    if (!evt || evt.delta !== false) tick(st);
    else if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st));
  }
  function handleEvent(payload, st, receivedAt) {
    if (!st || !st.active) return;
    var evt = null;
    try {
      evt = JSON.parse(payload);
    } catch (e) {
      return;
    }
    if (!evt || typeof evt !== "object") return;
    st.eventAt = typeof receivedAt === "number" ? receivedAt : now();
    debugLogEvent(evt);
    var _prevAt = st.lastEventAt || 0;
    st.lastEventAt = st.eventAt;
    st.prevEventAt = _prevAt;
    if (!st.model) st.model = getCurrentModel();
    if (evt.model && typeof evt.model === "string") st.model = evt.model;
    if (evt.data && evt.data.model && typeof evt.data.model === "string") st.model = evt.data.model;
    var usage = extractUsage(evt);
    if (usage && usage.generated >= 0 && (!st.finalUsage || !st.finalUsage.exact || usage.exact)) {
      st.promptTokens = usage.promptTokens || 0;
      st.totalTokens = usage.total;
      if (typeof usage.cacheHit === "number") {
        st.cacheHitTokens = usage.cacheHit;
      }
      if (usage.model) st.model = usage.model;
      if (usage.provider) st.providerUsage = usage.provider;
      st.finalUsage = usage;
    }
    var type = evt.type || evt.event || "message";
    if (type !== "error" && /^(text|reasoning|data|plugin_call|plugin_call_output|turn_usage)$/.test(type)) {
      st.pendingError = "";
      if (st.endCause === "error_frame") st.endCause = "";
    }
    if (type === "error") {
      var emsg = "";
      try {
        emsg = String(evt.data && (evt.data.message || evt.data.error) || evt.message || evt.error || "\u6D41\u5185 error \u5E27");
      } catch (e2) {
        emsg = "\u6D41\u5185 error \u5E27";
      }
      st.pendingError = emsg.slice(0, 80);
      st.endCause = "error_frame";
      warnOnce("errorframe", "SSE \u51FA\u73B0 error \u5E27\uFF1A" + st.pendingError + "\uFF081.6s \u5185\u82E5\u8FD8\u6709\u65B0\u4E8B\u4EF6\u5219\u5FFD\u7565\uFF0C\u4E0D\u5224\u51FA\u9519\uFF09");
      return;
    }
    if (type === "replay_end" || type === "replayEnd") {
      st.replayEndSeen = true;
      st.replayDone = true;
      st.diagReplayEnd = "replay_end";
      if (st.attached) {
        st.currentSeg = null;
        st.window = [];
        st.evWin = [];
        st.lastSpeed = 0;
        st.toolPending = Object.keys(st.toolCalls).length > 0;
        st.toolStartT = st.toolPending ? st.eventAt : 0;
        st.toolResumeAt = 0;
        st.tLast = 0;
        st.idleAccountedUntil = 0;
        st.pauseMs = 0;
        st.liveStartT = 0;
      }
      return;
    }
    if (String(evt.status).toLowerCase() === "completed" && Array.isArray(evt.content) && (type === "reasoning" || type === "message")) {
      if (evt.role === "assistant" || !evt.role) {
        evt.content.forEach(function(block, index) {
          if (!block || typeof block.text !== "string" || !block.text) return;
          var id = block.msg_id || evt.id || evt.msg_id || "";
          var idx = block.index != null ? block.index : index;
          var kind = type === "reasoning" && st.textSnapshots[[id, "reasoning", idx].join("|")] != null ? "reasoning" : "text";
          addDelta(block.text, st, { type: kind, msg_id: id, index: idx, delta: false });
        });
        if (type !== "reasoning" && evt.id) st.messageId = evt.id;
      }
      return;
    }
    if (type === "reasoning") {
      var rtext = "";
      if (typeof evt.text === "string" && evt.text) rtext = evt.text;
      else if (evt.content) rtext = extractFullText(evt.content);
      if (rtext) {
        addDelta(rtext, st, evt);
      } else {
        st.eventCount++;
      }
      return;
    }
    if (type === "text" && typeof evt.text === "string" && evt.text) {
      addDelta(evt.text, st, evt);
      return;
    }
    if (type === "data" && evt.data) {
      var sharedCall = evt.data.call_id;
      var messageId = evt.msg_id || evt.id || "";
      if (sharedCall && messageId) {
        st.toolMessageCalls[messageId] = sharedCall;
        if (st.toolCalls[messageId]) {
          delete st.toolCalls[messageId];
          st.toolCalls[sharedCall] = true;
        }
      }
      var boundCall = sharedCall || st.toolMessageCalls[messageId];
      if (boundCall && typeof evt.data.arguments === "string" && !st.toolPending) beginTool(st, boundCall, st.eventAt);
      if (boundCall && Object.prototype.hasOwnProperty.call(evt.data, "output") && String(evt.status).toLowerCase() === "completed") completeTool(st, boundCall, st.eventAt);
    }
    if (type === "data" && evt.delta === true && evt.data && typeof evt.data.arguments === "string" && evt.data.arguments) {
      var _arg = evt.data.arguments;
      st.toolCharCount += _arg.length;
      var _argTok = estimateTokens(_arg, st.model);
      st.toolEstTokens += _argTok;
      st.toolTokens += _argTok;
      if (st.attached && !st.replayDone) {
        st.replayToolTokens += _argTok;
        renderer.renderReplay(st);
        return;
      }
      var _argT = st.eventAt;
      if (!st.tFirst) {
        st.tFirst = _argT;
        st.ttft = _argT - st.t0;
      }
      if (!st.liveStartT) st.liveStartT = _argT;
      if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st));
      return;
    }
    if (type === "plugin_call" || type === "plugin_call_output") {
      var _bd = st.eventAt;
      st.lastEventAt = _bd;
      st.eventCount++;
      var callId = String(evt.call_id || evt.data && evt.data.call_id || st.toolMessageCalls[evt.id] || evt.id || "default");
      if (type === "plugin_call") {
        beginTool(st, callId, _bd);
      } else if (!/^(in_progress|created)$/.test(String(evt.status))) completeTool(st, callId, _bd);
      return;
    }
    var obj = evt.object;
    var status = evt.status;
    if (obj === "content" && evt.delta === true && typeof evt.text === "string" && evt.text) {
      addDelta(evt.text, st, evt);
      return;
    }
    if (obj === "message" && String(status).toLowerCase() === "completed") {
      var full = extractFullText(evt.content || evt);
      if (full) st.fullText = full;
      return;
    }
  }

  // src/stream.js
  function patchFetch() {
    if (typeof window.fetch !== "function") return;
    var origFetch = window.fetch;
    window.fetch = function(input, init2) {
      var url = typeof input === "string" ? input : String(input && input.url || input || "");
      var method = String(init2 && init2.method || input && input.method || "GET").toUpperCase();
      var meta = {};
      try {
        var body = init2 && init2.body;
        if (typeof body === "string") meta = JSON.parse(body) || {};
      } catch (e) {
      }
      var sid = String(meta.chat_id || getSessionId());
      if (sid === "default" && meta.session_id) sid = String(meta.session_id);
      if (method === "POST" && /\/console\/chat\/stop(?:\?|$)/.test(url)) {
        try {
          var target = new URL(url, location.href || "http://localhost").searchParams.get("chat_id") || meta.chat_id || meta.session_id || sid;
          Object.keys(store.states).forEach(function(k) {
            var state = store.states[k];
            if (state && state.active && (k === target || state.requestSessionId === target)) {
              state.userStopped = true;
              state.endCause = "user_stop";
            }
          });
        } catch (eStop) {
        }
        return origFetch.apply(this, arguments);
      }
      if (method !== "POST" || !/\/console\/chat(?:\?|$)/.test(url)) {
        var historyMatch = method === "GET" && /\/api\/chats\/([^/?]+)(?:\?|$)/.exec(url);
        if (historyMatch) {
          var historySid = decodeURIComponent(historyMatch[1]);
          var historyEpoch = store.states[historySid] ? store.states[historySid].epoch : 0;
          return origFetch.apply(this, arguments).then(function(response) {
            if (response && response.ok) {
              try {
                response.clone().json().then(function(data) {
                  if ((store.states[historySid] ? store.states[historySid].epoch : 0) === historyEpoch) hydrateChatHistory(historySid, data);
                }).catch(function() {
                });
              } catch (eHistory) {
              }
            }
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      }
      var startTime = now();
      var myState = getState(sid);
      var myEpoch = ++store.streamEpoch;
      startTurn(startTime, myState, myEpoch, {
        reconnect: meta.reconnect === true,
        fresh: meta.reconnect === false || Array.isArray(meta.input)
      });
      myState.requestSessionId = String(meta.session_id || "");
      pruneStates();
      if (!(init2 && init2.body) && input && typeof input.clone === "function") {
        try {
          input.clone().text().then(function(raw) {
            if (myState.epoch !== myEpoch) return;
            try {
              myState.requestSessionId = String(JSON.parse(raw).session_id || "");
            } catch (eJSON) {
            }
          }).catch(function() {
          });
        } catch (eBody) {
        }
      }
      try {
        refreshActiveLlm(true);
      } catch (eRefresh) {
      }
      var promise;
      try {
        promise = origFetch.apply(this, arguments);
      } catch (error) {
        finishAbnormal(myState, String(error.message || error), "read_error");
        throw error;
      }
      return promise.then(function(resp) {
        if (myState.epoch !== myEpoch) return resp;
        if (!resp || !resp.ok || !resp.body) {
          finishAbnormal(myState, "HTTP " + (resp && resp.status || "no response"), "http_error");
          return resp;
        }
        var ct = "";
        try {
          ct = String(resp.headers.get("content-type") || "").toLowerCase();
        } catch (eHeaders) {
        }
        if (ct && ct.indexOf("event-stream") < 0) {
          finishAbnormal(myState, "Response is not an event stream", "content_type");
          return resp;
        }
        try {
          monitorStream(resp.clone(), startTime, myState, myEpoch);
        } catch (eClone) {
          finishAbnormal(myState, "Stream observer unavailable", "observer_error");
        }
        return resp;
      }, function(error) {
        if (myState.epoch === myEpoch) {
          finishAbnormal(
            myState,
            String(error && error.message || error),
            store.pageLeaving ? "page_refresh" : "read_error"
          );
        }
        throw error;
      });
    };
  }
  function monitorStream(resp, t0, st, epoch) {
    var reader = resp.body.getReader();
    if (!st || st.epoch > epoch) {
      try {
        Promise.resolve(reader.cancel()).catch(function() {
        });
      } catch (e) {
      }
      return;
    }
    if (st.epoch !== epoch || !st.active) startTurn(t0, st, epoch);
    var decoder = new TextDecoder();
    var buf = "", lines = [], eventType = "", ended = false, receivedAt = 0;
    function stale() {
      return st.epoch !== epoch;
    }
    function cancel() {
      try {
        Promise.resolve(reader.cancel()).catch(function() {
        });
      } catch (e) {
      }
    }
    function dispatch() {
      if (!lines.length || stale() || ended) {
        lines = [];
        eventType = "";
        return;
      }
      var payload = lines.join("\n");
      lines = [];
      if (payload.trim() === "[DONE]") {
        ended = true;
        finishStream(st);
        eventType = "";
        return;
      }
      try {
        if (eventType) {
          var obj = JSON.parse(payload);
          if (obj && typeof obj === "object" && !obj.type) {
            obj.type = eventType;
            payload = JSON.stringify(obj);
          }
        }
        handleEvent(payload, st, receivedAt);
      } catch (eEvent) {
        warnOnce("observer", "\u7EDF\u8BA1\u4E8B\u4EF6\u5904\u7406\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1B\u804A\u5929\u6D41\u7EE7\u7EED\u4F20\u9012");
      }
      eventType = "";
    }
    function line(value) {
      if (value === "") {
        dispatch();
        return;
      }
      if (value.charAt(0) === ":") return;
      var colon = value.indexOf(":");
      var field = colon < 0 ? value : value.slice(0, colon);
      var content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
      if (field === "data") lines.push(content);
      else if (field === "event") eventType = content;
    }
    function consume(final) {
      var match;
      while (match = /[\r\n]/.exec(buf)) {
        var index = match.index;
        if (buf[index] === "\r" && index === buf.length - 1 && !final) break;
        var size = buf[index] === "\r" && buf[index + 1] === "\n" ? 2 : 1;
        var value = buf.slice(0, index);
        buf = buf.slice(index + size);
        line(value);
        if (stale() || ended) return;
      }
      if (final) {
        if (buf) line(buf);
        buf = "";
        dispatch();
      }
    }
    function pump() {
      reader.read().then(function(result) {
        if (stale() || ended) {
          cancel();
          return;
        }
        if (result.done) {
          buf += decoder.decode();
          consume(true);
          if (!ended) finishStream(st);
          try {
            reader.releaseLock();
          } catch (eLock) {
          }
          return;
        }
        receivedAt = now();
        buf += decoder.decode(result.value, { stream: true });
        if (buf.length > 4194304) {
          finishAbnormal(st, "SSE buffer overflow", "read_error");
          cancel();
          return;
        }
        consume(false);
        if (stale() || ended) {
          cancel();
          return;
        }
        pump();
      }).catch(function(error) {
        if (stale() || ended) return;
        finishAbnormal(st, String(error && (error.message || error.name) || "read error"), "read_error");
        try {
          reader.releaseLock();
        } catch (eLock) {
        }
      });
    }
    pump();
  }
  function finishStream(st) {
    if (!st || !st.active) return;
    if (st.userStopped) {
      finishAbnormal(st, "", "user_stop");
      return;
    }
    if (st.pendingError) {
      finishAbnormal(st, st.pendingError, "error_frame");
      return;
    }
    endTurn(DONE, st, "", "stream_end");
  }
  function finishAbnormal(st, msg, cause) {
    if (!st || !st.active) return;
    var hasOutput = !!(st.tFirst || st.tokenCount > 0 || st.estimatedTokens > 0 || st.charCount > 0 || st.toolTokens > 0 || (st.replayTokens || 0) > 0);
    if (!st.userStopped && st.__sid !== getSessionId()) {
      st.active = false;
      st.suspended = true;
      st.lastSpeed = 0;
      return;
    }
    var navAbort = store.pageLeaving && !hasOutput;
    var status = st.userStopped || hasOutput || navAbort ? "abort" : "error";
    var c = st.userStopped ? "user_stop" : navAbort ? "page_refresh" : cause || "read_error";
    endTurn(status, st, msg, c);
  }
  function hydrateChatHistory(sid, data) {
    if (!data || !Array.isArray(data.messages)) return;
    var state = store.states[sid];
    if (state && state.active) return;
    if (/running|in_progress|pending|generating/i.test(String(data.status || ""))) return;
    var messages = data.messages, lastUser = -1;
    for (var i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
    var message = null, usage = null;
    for (var j = messages.length - 1; j > lastUser; j--) {
      var candidate = messages[j];
      if (candidate.role !== "assistant") continue;
      var metadata = candidate.metadata || {};
      var nested = metadata.metadata || {};
      var snapshot = nested.qwenpaw_turn_usage || metadata.qwenpaw_turn_usage;
      if (!snapshot || !snapshot.usage) continue;
      usage = extractUsage({ type: "turn_usage", usage: snapshot.usage });
      if (usage) {
        message = candidate;
        break;
      }
    }
    if (!message || !usage) return;
    if (state) state.suspended = false;
    var previous = loadLastResult(sid);
    var meta = message.metadata || {};
    var end = Date.parse(meta.finished_at || meta.timestamp || "");
    var turnKey = meta.original_id || message.id;
    var sameMeasuredTurn = previous && !previous.historyOnly && previous.outputTokens === usage.generated && previous.total === usage.total && (previous.turnKey === turnKey || Math.abs(previous.ts - end) < 2e3);
    if (sameMeasuredTurn) {
      previous.turnKey = turnKey;
      saveLastResult(sid, previous);
      return;
    }
    var startMeta = lastUser >= 0 ? messages[lastUser].metadata || {} : {};
    var start = Date.parse(startMeta.timestamp || "");
    if (previous && previous.messageId && end && previous.ts > end + 2e3) return;
    var channel = currentChannel(usage.provider);
    var money = moneyFields(channel.channel, usage.model, usage.promptTokens, usage.generated, usage.cacheHit);
    var turnState = startMeta.metadata && startMeta.metadata.qwenpaw_turn_state;
    var aborted = /abort|cancel|stop/i.test(String(turnState && turnState.status || ""));
    var result = {
      ts: isFinite(end) ? end : Date.now(),
      messageId: message.id,
      turnKey,
      historyOnly: true,
      tokenSource: "usage",
      outputTokens: usage.generated,
      tokens: usage.generated,
      toolTokens: 0,
      total: usage.total,
      promptTokens: usage.promptTokens,
      costTokens: usage.generated,
      cacheHit: usage.cacheHit,
      cacheMiss: Math.max(0, usage.promptTokens - usage.cacheHit),
      model: usage.model,
      provider: usage.provider,
      channel: channel.channel,
      channelSrc: "usage",
      cost: money.cost,
      costUnit: money.costUnit,
      afp: money.afp,
      coefMissing: money.coefMissing,
      priceMissing: money.priceMissing,
      aliasModel: money.aliasModel,
      coefRange: money.coefRange,
      afpLo: money.afpLo,
      afpHi: money.afpHi,
      tp: money.tp,
      tpLo: money.tpLo,
      tpHi: money.tpHi,
      tpRange: money.tpRange,
      status: aborted ? "abort" : DONE,
      endCause: aborted ? "user_stop" : "history",
      errMsg: "",
      ttft: 0,
      seconds: isFinite(start) && isFinite(end) && end >= start ? (end - start) / 1e3 : 0,
      secondsKnown: isFinite(start) && isFinite(end) && end >= start,
      genTime: 0,
      genSpeed: 0,
      avg: 0,
      peak: 0,
      pauseSec: 0,
      segments: [],
      attached: false,
      replayTokens: 0,
      totalGenerated: usage.generated,
      liveTokens: 0
    };
    saveLastResult(sid, result);
    appendLedger(sid, result);
    if (sid === getSessionId()) {
      renderer.refreshBarContent();
      renderer.refreshDetail(result);
    }
  }
  function channelRank(src) {
    if (src === "usage") return 3;
    if (src === "active") return 2;
    if (src === "model" || src === "memory") return 1;
    return 0;
  }
  function applyBillingRetro(force) {
    try {
      let tpSig = function(x) {
        return x.tp ? x.tp.credits + ":" + x.tp.factor : x.tpRange ? "r:" + x.tpLo + ":" + x.tpHi : "n";
      };
      var cur = currentChannel("");
      Object.keys(store.states).forEach(function(sid) {
        var st = store.states[sid];
        if (!st || !st.active) return;
        var c = st.providerUsage ? currentChannel(st.providerUsage) : cur;
        if (c.channel && (force || channelRank(c.src) >= channelRank(st.channelSrc))) {
          st.channel = c.channel;
          st.channelSrc = c.src;
          st.provider = c.provider || st.provider;
        }
      });
      var sid2 = getSessionId();
      var r = loadLastResult(sid2);
      if (!r || typeof r !== "object") return;
      if (r.provider) {
        cur = {
          channel: resolveChannel(r.provider, providerBaseUrl(r.provider)),
          provider: r.provider,
          src: r.channelSrc === "usage" ? "usage" : "memory"
        };
      }
      if (!cur.channel) return;
      var stronger = channelRank(cur.src) > channelRank(r.channelSrc);
      var upgraded = !!force && (!r.channel || r.channel === "other") && cur.channel !== r.channel;
      if (!stronger && !upgraded) return;
      var pt = r.promptTokens != null ? r.promptTokens : (r.cacheHit || 0) + (r.cacheMiss || 0);
      var ct = r.costTokens != null ? r.costTokens : r.tokens;
      var money = moneyFields(cur.channel, r.model, pt, ct, r.cacheHit || 0);
      var before = [
        r.cost == null ? "n" : r.cost,
        r.afp == null ? "n" : r.afp,
        r.channel || "",
        r.afpLo == null ? "n" : r.afpLo,
        r.afpHi == null ? "n" : r.afpHi,
        tpSig(r)
      ].join("|");
      var after = [
        money.cost == null ? "n" : money.cost,
        money.afp == null ? "n" : money.afp,
        money.channel,
        money.afpLo == null ? "n" : money.afpLo,
        money.afpHi == null ? "n" : money.afpHi,
        tpSig(money)
      ].join("|");
      if (before === after) return;
      r.cost = money.cost;
      r.afp = money.afp;
      r.channel = money.channel;
      r.channelSrc = cur.src;
      r.provider = cur.provider || r.provider;
      r.coefMissing = money.coefMissing;
      r.priceMissing = money.priceMissing;
      r.aliasModel = money.aliasModel;
      r.afpLo = money.afpLo;
      r.afpHi = money.afpHi;
      r.costUnit = money.costUnit;
      r.coefRange = money.coefRange;
      r.tp = money.tp;
      r.tpLo = money.tpLo;
      r.tpHi = money.tpHi;
      r.tpRange = money.tpRange;
      saveLastResult(sid2, r);
      appendLedger(sid2, r);
      renderer.refreshBarContent();
      renderer.refreshDetail(r);
    } catch (e) {
    }
  }

  // src/ui-styles.js
  var styles = `
    #qp-token-speed-bar, #qp-token-speed-detail {
      --qp-bg: rgba(16,22,31,.96); --qp-panel: #131b26; --qp-ink: #eef3fa; --qp-mut: #8b99ad;
      --qp-mint: #7fe7c4; --qp-blue: #8fb8ff; --qp-gold: #ffd479; --qp-warn: #f6ce9e; --qp-err: #ff9d9d;
      --qp-line: #ffffff14;
      box-sizing:border-box; font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; font-variant-numeric:tabular-nums; color:var(--qp-ink); line-height:1.5;
    }
    /* \u2500\u2500 \u60AC\u6D6E\u6761\uFF1A\u4EEA\u8868\u6761 \u2500\u2500 */
    #qp-token-speed-bar { position:fixed; z-index:50; display:flex; align-items:center; gap:14px; width:max-content; max-width:calc(100vw - 24px); padding:7px 10px 7px 14px; border-radius:14px; border:1px solid #ffffff1f; background:var(--qp-bg); box-shadow:0 8px 28px #0006; cursor:pointer; user-select:none; font-size:12px; white-space:nowrap; backdrop-filter:blur(18px); overflow:hidden; }
    #qp-token-speed-bar::after { content:""; position:absolute; left:0; right:0; top:0; height:1px; background:linear-gradient(90deg,transparent,#7fe7c455,transparent); opacity:0; }
    #qp-token-speed-bar.running::after { opacity:1; animation:qp-ts-scan 2.4s linear infinite; }
    @keyframes qp-ts-scan { 0% { transform:translateX(-60%); } 100% { transform:translateX(60%); } }
    #qp-token-speed-bar:hover { border-color:#7fe7c455; background:#182230; }
    #qp-token-speed-bar:focus-visible { outline:2px solid var(--qp-mint); outline-offset:3px; }
    #qp-token-speed-bar .qp-ts-state { display:inline-flex; align-items:center; gap:7px; color:#bcc9df; font-size:11px; flex-shrink:0; }
    #qp-token-speed-bar .qp-ts-dot { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:#8d9bb4; }
    #qp-token-speed-bar.done .qp-ts-dot { background:var(--qp-blue); }
    #qp-token-speed-bar.running .qp-ts-dot { background:var(--qp-mint); animation:qp-ts-pulse 1.6s infinite; }
    #qp-token-speed-bar.abort .qp-ts-dot { background:var(--qp-warn); }
    #qp-token-speed-bar.error .qp-ts-dot { background:var(--qp-err); }
    #qp-token-speed-bar .qp-ts-model { max-width:150px; overflow:hidden; text-overflow:ellipsis; color:#9fb0c8; font-size:11px; border-left:1px solid var(--qp-line); padding-left:12px; }
    #qp-token-speed-bar .qp-ts-item { display:inline-flex; align-items:baseline; gap:6px; }
    #qp-token-speed-bar .qp-ts-label { color:#aab8ce; font-size:11px; }
    #qp-token-speed-bar .qp-ts-val { font-weight:600; color:#f2f6ff; }
    #qp-token-speed-bar .qp-ts-speed .qp-ts-val { color:var(--qp-mint); font-size:18px; letter-spacing:-.4px; }
    #qp-token-speed-bar .qp-ts-unit { color:#aab8ce; font-size:10px; font-weight:400; margin-left:3px; }
    #qp-token-speed-bar .qp-ts-cost { padding:2px 8px; border-radius:8px; border:1px solid var(--qp-line); background:#ffffff07; }
    #qp-token-speed-bar .qp-ts-cost .qp-ts-val { font-size:12px; }
    #qp-token-speed-bar .qp-ts-cost.credits { border-color:#ffd47930; }
    #qp-token-speed-bar .qp-ts-cost.credits .qp-ts-val { color:var(--qp-gold); }
    #qp-token-speed-bar .qp-ts-cost.cny .qp-ts-val { color:#a8ecd9; }
    #qp-token-speed-bar .qp-ts-cost.plan .qp-ts-val { color:var(--qp-blue); }
    #qp-token-speed-bar .qp-ts-more { padding:4px 8px; border-radius:8px; color:#d7e6ff; background:#ffffff0c; font-size:11px; flex-shrink:0; }
    #qp-token-speed-bar .qp-ts-extra { border-left:1px solid var(--qp-line); padding-left:12px; }
    @keyframes qp-ts-pulse { 50% { opacity:.4; } }
    /* \u2500\u2500 \u8BE6\u60C5\u9762\u677F\uFF1A\u98DE\u884C\u6570\u636E\u8BFB\u6570 \u2500\u2500 */
    #qp-token-speed-detail { position:fixed; z-index:100; top:50%; left:50%; transform:translate(-50%,-50%); width:720px; max-width:calc(100vw - 32px); max-height:calc(100dvh - 48px); overflow:auto; padding:24px; border-radius:22px; border:1px solid #ffffff22; background:var(--qp-panel); box-shadow:0 24px 100px #000a; font-size:13px; scrollbar-width:thin; scrollbar-color:#42516c transparent; }
    #qp-token-speed-detail * { box-sizing:border-box; }
    #qp-token-speed-detail .qp-d-title { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; }
    #qp-token-speed-detail .qp-d-eyebrow { color:var(--qp-mint); letter-spacing:1.8px; font-size:10px; font-weight:600; margin-bottom:4px; opacity:.85; }
    #qp-token-speed-detail .qp-d-heading { font-size:21px; font-weight:650; letter-spacing:-.4px; }
    #qp-token-speed-detail .qp-d-meta { margin-top:6px; color:#9eadc5; font-size:12px; overflow-wrap:anywhere; }
    #qp-token-speed-detail .qp-d-tools { display:flex; align-items:center; gap:12px; flex-shrink:0; }
    #qp-token-speed-detail .qp-d-badge { display:inline-flex; align-items:center; gap:6px; color:#a8ecd9; background:#79dbb810; border:1px solid #79dbb82a; border-radius:7px; padding:3px 8px; font-size:11px; }
    #qp-token-speed-detail .qp-d-badge.abort { color:#ffd4a8; background:#ffc28112; border-color:#ffc28130; }
    #qp-token-speed-detail .qp-d-badge.error { color:var(--qp-err); background:#ff9d9d10; border-color:#ff9d9d30; }
    #qp-token-speed-detail .qp-d-close { display:grid; place-items:center; width:30px; height:30px; border:1px solid #ffffff12; border-radius:9px; background:#ffffff05; color:#aebbd1; cursor:pointer; font-size:16px; line-height:1; }
    #qp-token-speed-detail .qp-d-close:hover { color:white; background:#ffffff14; }
    #qp-token-speed-detail button:focus-visible, #qp-token-speed-detail select:focus-visible { outline:2px solid var(--qp-mint); outline-offset:2px; }
    /* hero \u4E09\u5361\uFF1A\u901F\u5EA6 / \u8F93\u51FA / \u8BA1\u8D39 */
    #qp-token-speed-detail .qp-d-hero { display:grid; grid-template-columns:1.15fr 1fr 1.1fr; gap:10px; margin-bottom:12px; }
    #qp-token-speed-detail .qp-d-card { padding:16px 16px 13px; background:#ffffff04; border:1px solid #ffffff12; border-radius:15px; min-width:0; }
    #qp-token-speed-detail .qp-d-card.speed { background:linear-gradient(125deg,#2a5a5245,#1d324215); border-color:#7fe7c436; }
    #qp-token-speed-detail .qp-d-card.bill.credits { background:linear-gradient(125deg,#5a4a2a3d,#32281d15); border-color:#ffd47936; }
    #qp-token-speed-detail .qp-d-label { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#b6c5db; font-size:12px; }
    #qp-token-speed-detail .qp-d-tag { padding:1px 5px; color:#a8c4ec; border:1px solid #8daedc35; border-radius:4px; font-size:10px; white-space:nowrap; }
    #qp-token-speed-detail .qp-d-number { display:flex; align-items:baseline; gap:6px; margin:6px 0 4px; font-size:34px; font-weight:600; letter-spacing:-1.2px; line-height:1.3; color:#f3f7ff; overflow-wrap:anywhere; }
    #qp-token-speed-detail .speed .qp-d-number { color:var(--qp-mint); }
    #qp-token-speed-detail .bill.credits .qp-d-number { color:var(--qp-gold); }
    #qp-token-speed-detail .qp-d-number small { font-size:12px; font-weight:400; letter-spacing:0; color:#9fadc3; }
    #qp-token-speed-detail .qp-d-caption { color:#98a9c1; font-size:11px; line-height:1.6; }
    #qp-token-speed-detail .qp-d-burn { color:var(--qp-gold); font-size:11px; margin-top:2px; }
    #qp-token-speed-detail .qp-d-disc { display:inline-block; padding:0 5px; margin-right:4px; border-radius:4px; color:#1a1408; background:var(--qp-gold); font-size:10px; font-weight:600; }
    #qp-token-speed-detail .qp-spark { display:block; width:100%; height:38px; margin:4px 0 2px; }
    /* \u65F6\u95F4\u5E26 */
    #qp-token-speed-detail .qp-d-timings { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid #ffffff12; border-radius:13px; padding:13px 0; margin-bottom:18px; background:#0c142320; }
    #qp-token-speed-detail .qp-d-time { padding:0 14px; border-left:1px solid #ffffff10; }
    #qp-token-speed-detail .qp-d-time:first-child { border-left:0; }
    #qp-token-speed-detail .qp-d-time span { display:block; color:#99abc4; font-size:11px; }
    #qp-token-speed-detail .qp-d-time strong { display:block; margin-top:5px; font-size:17px; font-weight:550; color:#e3ecfb; }
    /* \u7AE0\u8282\u4E0E\u7528\u91CF\u7F51\u683C */
    #qp-token-speed-detail .qp-d-section { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 10px; font-size:12px; font-weight:600; color:#d8e4f7; }
    #qp-token-speed-detail .qp-d-section small { font-size:10px; color:#859ab8; font-weight:400; }
    #qp-token-speed-detail .qp-d-usage { display:grid; grid-template-columns:1fr 1fr; gap:0 26px; padding:2px 0 14px; }
    #qp-token-speed-detail .qp-c { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:7px 0; min-width:0; }
    #qp-token-speed-detail .qp-cl { color:#98abc5; font-size:12px; }
    #qp-token-speed-detail .qp-cv { text-align:right; color:#e0eafd; font-size:12px; overflow-wrap:anywhere; }
    /* Credits \u4E09\u5206\u91CF\u6761 */
    #qp-token-speed-detail .qp-tp { padding:2px 0 14px; }
    #qp-token-speed-detail .qp-tp-row { display:grid; grid-template-columns:44px 1fr 72px; align-items:center; gap:10px; padding:4px 0; }
    #qp-token-speed-detail .qp-tp-l { color:#98abc5; font-size:11px; }
    #qp-token-speed-detail .qp-tp-track { height:8px; border-radius:4px; background:#ffffff0a; overflow:hidden; }
    #qp-token-speed-detail .qp-tp-fill { display:block; height:100%; border-radius:4px; }
    #qp-token-speed-detail .qp-tp-fill.in { background:var(--qp-blue); }
    #qp-token-speed-detail .qp-tp-fill.ca { background:#6ee7b7; }
    #qp-token-speed-detail .qp-tp-fill.out { background:var(--qp-gold); }
    #qp-token-speed-detail .qp-tp-v { text-align:right; color:#e0eafd; font-size:11px; }
    #qp-token-speed-detail .qp-tp-note { color:#91a4c0; font-size:10px; line-height:1.6; padding-top:4px; }
    /* \u4ECA\u65E5\u8D26\u672C */
    #qp-token-speed-detail .qp-lg { padding:2px 0 14px; }
    #qp-token-speed-detail .qp-lg-sum { display:flex; flex-wrap:wrap; gap:6px 14px; color:#c3d0e4; font-size:12px; }
    #qp-token-speed-detail .qp-lg-cr { color:var(--qp-gold); font-weight:600; }
    #qp-token-speed-detail .qp-lg-cny { color:#a8ecd9; font-weight:600; }
    #qp-token-speed-detail .qp-lg-plan { color:var(--qp-blue); font-weight:600; }
    #qp-token-speed-detail .qp-lg-amort { color:#98a9c1; }
    #qp-token-speed-detail .qp-lg-models { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    #qp-token-speed-detail .qp-lg-m { padding:2px 8px; border:1px solid var(--qp-line); border-radius:7px; color:#9fb0c8; font-size:11px; background:#ffffff05; }
    #qp-token-speed-detail .qp-tp-select { margin-left:auto; padding:2px 6px; border-radius:6px; border:1px solid #ffd47930; background:#1a2230; color:var(--qp-gold); font-size:11px; cursor:pointer; }
    /* \u8BF4\u660E / \u56FE\u8868 / \u5206\u6BB5\u8868 */
    #qp-token-speed-detail .qp-d-explain { color:#91a4c0; font-size:11px; line-height:1.7; border-top:1px solid #ffffff12; padding-top:12px; margin-bottom:18px; }
    #qp-token-speed-detail .qp-d-note { font-size:11px; color:var(--qp-warn); background:#e9a55e0b; border:1px solid #dba66d2a; border-radius:9px; padding:8px 11px; margin-bottom:12px; line-height:1.6; }
    #qp-token-speed-detail .qp-d-chart { margin-bottom:8px; background:#0d172440; border-radius:12px; }
    #qp-token-speed-detail .qp-d-chart svg { display:block; width:100%; height:auto; }
    #qp-token-speed-detail .qp-d-empty { padding:12px 16px; text-align:left; color:#92a6c3; font-size:11px; line-height:1.7; }
    #qp-token-speed-detail .qp-d-segtitle, #qp-token-speed-detail .qp-d-row { display:grid; grid-template-columns:.55fr 1fr 1fr 1.3fr; align-items:center; gap:10px; }
    #qp-token-speed-detail .qp-d-segtitle { padding:8px 12px; color:#8196b5; font-size:10px; }
    #qp-token-speed-detail .qp-d-segs { max-height:150px; overflow:auto; scrollbar-width:thin; }
    #qp-token-speed-detail .qp-d-segs:empty { display:none; }
    #qp-token-speed-detail .qp-d-row { padding:9px 12px; font-size:12px; border-top:1px solid #ffffff0a; }
    #qp-token-speed-detail .qp-d-cur { background:#76d9be08; }
    #qp-token-speed-detail .qp-ri { color:#8196b5; }
    #qp-token-speed-detail .qp-rd { color:#a5b7d0; }
    #qp-token-speed-detail .qp-rs { color:#a0d8d2; text-align:right; }
    #qp-token-speed-detail .qp-d-segtitle span:last-child { text-align:right; }
    @media(max-width:640px) {
      #qp-token-speed-bar { gap:10px; padding:7px 9px; border-radius:12px; }
      #qp-token-speed-bar .qp-ts-extra, #qp-token-speed-bar .qp-ts-model { display:none; }
      #qp-token-speed-bar .qp-ts-speed .qp-ts-val { font-size:16px; }
      #qp-token-speed-bar .qp-ts-state { font-size:10px; }
      #qp-token-speed-detail { max-width:calc(100vw - 20px); max-height:calc(100dvh - 24px); padding:18px; border-radius:19px; }
      #qp-token-speed-detail .qp-d-heading { font-size:19px; }
      #qp-token-speed-detail .qp-d-title { margin-bottom:16px; gap:8px; }
      #qp-token-speed-detail .qp-d-tools { gap:6px; }
      #qp-token-speed-detail .qp-d-hero { grid-template-columns:1fr; gap:8px; }
      #qp-token-speed-detail .qp-d-card { padding:14px 12px; }
      #qp-token-speed-detail .qp-d-number { font-size:29px; gap:4px; }
      #qp-token-speed-detail .qp-d-number small { font-size:10px; }
      #qp-token-speed-detail .qp-d-label { font-size:11px; flex-wrap:wrap; gap:4px; }
      #qp-token-speed-detail .qp-d-timings { grid-template-columns:1fr 1fr; row-gap:14px; }
      #qp-token-speed-detail .qp-d-time:nth-child(3) { border-left:0; }
      #qp-token-speed-detail .qp-d-usage { grid-template-columns:1fr; }
    }
    @media(prefers-reduced-motion:reduce) { #qp-token-speed-bar.running .qp-ts-dot { animation:none; } #qp-token-speed-bar.running::after { animation:none; } }
    /* \u4EE3\u7801\u5757\u6574\u4F53\u900F\u660E\u78E8\u7802\u5316\uFF0C\u4E0E\u804A\u5929\u6C14\u6CE1\u98CE\u683C\u7EDF\u4E00\uFF08dream-skin \u517C\u5BB9\uFF09 */
    html.qwenpaw-dream-skin {
      --qds-code-bg: transparent !important;
    }
    .qwenpaw-code-block,
    html.qwenpaw-dream-skin .qwenpaw-code-block {
      background-color: rgba(15, 23, 42, 0.55) !important;
      border: 1px solid rgba(255, 255, 255, 0.10) !important;
      backdrop-filter: blur(12px) saturate(150%) !important;
      -webkit-backdrop-filter: blur(12px) saturate(150%) !important;
      border-radius: 12px !important;
      overflow: hidden;
    }
    .qwenpaw-code-block [class*="sourceHeader"],
    html.qwenpaw-dream-skin .qwenpaw-code-block [class*="sourceHeader"] {
      background-color: rgba(255, 255, 255, 0.06) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
    }
    .qwenpaw-code-block [class*="index-module__panel"],
    html.qwenpaw-dream-skin .qwenpaw-code-block [class*="index-module__panel"] {
      background-color: transparent !important;
      height: auto !important;
      min-height: 0 !important;
    }
    .qwenpaw-code-block pre,
    html.qwenpaw-dream-skin .qwenpaw-code-block pre,
    .qwenpaw-code-block pre *,
    html.qwenpaw-dream-skin .qwenpaw-code-block pre * {
      background-color: transparent !important;
      color: rgba(226, 232, 250, 0.88) !important;
    }
    .qwenpaw-code-block pre {
      height: auto !important;
      min-height: 0 !important;
      border-radius: 0 !important;
    }
  `;
  function injectStyles() {
    if (document.getElementById("qp-token-speed-styles")) return;
    var s = document.createElement("style");
    s.id = "qp-token-speed-styles";
    s.textContent = styles;
    (document.head || document.documentElement).appendChild(s);
  }

  // src/ui-bar.js
  var ATTACH_TIP = "\u4E2D\u9014\u63A5\u5165\uFF1A\u5207\u5230\u4F1A\u8BDD\u65F6\u540E\u7AEF\u8865\u53D1\u7684\u5386\u53F2\u751F\u6210\u5185\u5BB9\uFF0C\u5176\u901F\u7387\u65E0\u53C2\u8003\u4EF7\u503C\uFF0C\u5DF2\u4ECE\u901F\u5EA6 / \u5CF0\u503C / \u5206\u6BB5\u4E2D\u5254\u9664\uFF1B\u56DE\u653E\u91CF\u4ECD\u8BA1\u5165\u603B\u91CF\u4E0E\u8D39\u7528";
  function buildWaitingHtml() {
    return barState("\u8FDE\u63A5\u4E2D") + '<span class="qp-ts-label">\u7B49\u5F85\u9996\u5B57\u5230\u8FBE\u2026</span>';
  }
  function channelLabel(ch) {
    if (ch === "plan" || ch === "afp") return "\u5957\u9910\u6E20\u9053";
    if (ch === "coding") return "Coding Plan";
    if (ch === "deepseek") return "DeepSeek \u5B98\u65B9";
    if (ch === "tokenplan") return "\u767E\u70BC Token Plan";
    if (ch === "dashscope") return "\u767E\u70BC\u6309\u91CF";
    if (ch === "other") return "\u5176\u4ED6\u6E20\u9053";
    return "\u672A\u8BC6\u522B";
  }
  function channelTip(ch, provider) {
    var head = "\u8BA1\u8D39\u6E20\u9053\uFF1A" + channelLabel(ch) + (provider ? "\uFF08" + provider + "\uFF09" : "") + "\u3002";
    if (ch === "plan" || ch === "afp") return head + "\u8D70\u5957\u9910\uFF08Agent Plan\uFF09\u6E20\u9053\uFF0C\u6309\u5957\u9910\u989D\u5EA6\u62B5\u6263\u2014\u2014\u540C\u4E00\u4E2A\u6A21\u578B\u540D\u5728\u6309\u91CF\u6E20\u9053\u662F\u4EBA\u6C11\u5E01\u8BA1\u8D39\uFF0C\u4E24\u8FB9\u8BA1\u8D39\u65B9\u5F0F\u4E92\u65A5\uFF0C\u6240\u4EE5\u53EA\u80FD\u6309\u6E20\u9053\u5224";
    if (ch === "coding") return head + "\u8D70 Coding Plan \u6E20\u9053\uFF08\u5730\u5740 /api/coding/v3 \u6216 coding.dashscope.aliyuncs.com\uFF09\uFF0C\u6309\u8BF7\u6C42\u6B21\u6570\u8BA1\u3001\u4E0D\u662F token/\u989D\u5EA6\uFF0C\u4E2A\u4EBA\u7248\u65E0\u516C\u5F00\u7528\u91CF API \u2192 \u672C\u63D2\u4EF6\u53EA\u62A5 token\uFF0C\u4E0D\u62A5\u91D1\u989D";
    if (ch === "deepseek") return head + "\u8D70 DeepSeek \u5B98\u65B9 API\uFF0C\u6309\u4EBA\u6C11\u5E01\u8BA1\u4EF7\uFF08\u5C16\u5CF0/\u4F4E\u8C37\u5355\u4EF7\u4E0D\u540C\uFF09";
    if (ch === "tokenplan") return head + "\u8D70\u963F\u91CC\u4E91\u767E\u70BC Token Plan\uFF0C\u6309 Credits \u62B5\u6263\uFF1Acredits/\u4E07tok \u7684\u6570\u503C = \u5B98\u65B9\u520A\u4F8B\u4EF7 \u5143/\u767E\u4E07tok\uFF081 credit = 0.01 \u5143\u520A\u4F8B\u4EF7\uFF09\u3002\u5317\u4EAC\u65F6\u95F4 22:00\u201308:00 \u90E8\u5206\u6A21\u578B\u4EAB\u5B98\u65B9\u591C\u95F4\u6298\u6263\uFF08qwen3.8 \u7CFB 4 \u6298 / deepseek-v4 \u7CFB 5 \u6298\uFF09\uFF0Cqwen4-max-preview \u9884\u89C8\u671F\u53E6\u6709 2 \u6298\uFF1Bplus/flash \u7CFB\u6309\u8F93\u5165 token \u9636\u68AF\u8BA1\u4EF7";
    if (ch === "dashscope") return head + "\u8D70\u963F\u91CC\u4E91\u767E\u70BC\u6309\u91CF\u4ED8\u8D39\uFF0C\u4EBA\u6C11\u5E01\u520A\u4F8B\u4EF7\u8BA1\u4EF7\uFF08DeepSeek \u7CFB\u6A21\u578B\u5206\u5FD9/\u95F2\u65F6\uFF0C\u5FD9 08:00\u201322:00 \u5317\u4EAC\uFF09\uFF1B\u4E0E Token Plan \u7684 Credits \u989D\u5EA6\u76F8\u4E92\u72EC\u7ACB\u3001\u4E0D\u4E92\u901A";
    if (ch === "other") return head + "\u4E0D\u662F\u5957\u9910/DeepSeek \u5B98\u65B9\u8FD9\u7C7B\u5185\u7F6E\u4EF7\u76EE\u6E20\u9053\uFF0C\u672C\u63D2\u4EF6\u6CA1\u6709\u8BE5\u6E20\u9053\u4EF7\u8868 \u2192 \u53EA\u62A5 token\uFF0C\u4E0D\u62A5\u91D1\u989D\uFF08\u53EF\u5728\u8986\u76D6\u5C42\u914D generic \u4EF7\u76EE\uFF09";
    return head + "\u62FF\u4E0D\u5230 provider \u4FE1\u606F\uFF08usage.provider_id \u4E3A\u7A7A\u3001/api/models/active \u4E5F\u8BFB\u4E0D\u5230\uFF09\u2192 \u53EA\u62A5 token\uFF0C\u4E0D\u62A5\u91D1\u989D\u3002\u5B81\u53EF\u7A7A\u7740\uFF0C\u4E5F\u4E0D\u6309\u6A21\u578B\u540D\u731C\u4E00\u4E2A\u9519\u6570";
  }
  function statusInfo(r, running) {
    if (running) return { text: "\u751F\u6210\u4E2D", tip: "\u6B63\u5728\u751F\u6210\uFF0C\u9762\u677F\u6BCF 600ms \u5C31\u5730\u5237\u65B0" };
    if (r && r.status === DONE) {
      if (r.historyOnly) return { text: "\u5386\u53F2\u7528\u91CF", tip: "\u4ECE\u540E\u7AEF\u804A\u5929\u8BB0\u5F55\u6062\u590D\u7CBE\u786E\u672C\u8F6E\u7528\u91CF\uFF1B\u672A\u89C2\u6D4B\u5230\u7684\u901F\u5EA6\u3001\u5CF0\u503C\u548C\u5206\u6BB5\u4E0D\u63A8\u7B97" };
      return { text: "\u5B8C\u6210", tip: r.endCause === "error_frame" ? "\u6D41\u6B63\u5E38\u7ED3\u675F\uFF08\u671F\u95F4\u51FA\u73B0\u8FC7 error \u5E27\uFF0C\u4F46\u4E4B\u540E\u4ECD\u5728\u4EA7\u51FA\uFF09" : "\u6D41\u6B63\u5E38\u7ED3\u675F" };
    }
    if (r && r.status === "abort") {
      var t = r.endCause === "user_stop" ? "\u4F60\u70B9\u4E86\u505C\u6B62" : r.endCause === "page_refresh" ? "\u9875\u9762\u5237\u65B0/\u5173\u95ED\uFF0C\u672C\u8F6E\u751F\u6210\u88AB\u4E2D\u6B62\uFF08\u96F6\u4EA7\u51FA\uFF0C\u672A\u8BA1\u5165\uFF09" : r.endCause === "error_frame" ? "\u6D41\u5185 error \u5E27\u4E4B\u540E\u4E0D\u518D\u6709\u5185\u5BB9" : "\u6D41\u88AB\u4E2D\u65AD\uFF08\u5207\u4F1A\u8BDD / \u5237\u65B0\u9875\u9762 / \u7F51\u7EDC\u65AD\u5F00\uFF09";
      return { text: "\u5DF2\u4E2D\u65AD", tip: t + (r.errMsg ? "\uFF1A" + r.errMsg : "") };
    }
    return {
      text: "\u51FA\u9519",
      tip: "\u4E00\u4E2A token \u90FD\u6CA1\u4EA7\u51FA\u6765\u5C31\u5931\u8D25\u4E86" + (r && r.errMsg ? "\uFF1A" + r.errMsg : "") + (r && r.endCause ? "\uFF08" + r.endCause + "\uFF09" : "")
    };
  }
  function barItem(label, value, cls, tip) {
    return '<span class="qp-ts-item ' + (cls || "") + '"' + (tip ? ' title="' + escHtml(tip) + '"' : "") + '><span class="qp-ts-label">' + label + '</span><span class="qp-ts-val">' + value + "</span></span>";
  }
  function barState(text, tip) {
    return '<span class="qp-ts-state" title="' + escHtml(tip || "") + '"><span class="qp-ts-dot"></span>' + text + "</span>";
  }
  function costChipHtml(r) {
    if (!r) return "";
    if (r.cost != null && r.costUnit === "credits") {
      return '<span class="qp-ts-item qp-ts-cost credits" title="\u672C\u8F6E Credits \u6D88\u8017\uFF08\u767E\u70BC Token Plan\uFF09\u2248' + escHtml(fmtMoney(creditsToCny(r.cost), "\xA5")) + ' \u520A\u4F8B\u4EF7"><span class="qp-ts-val">\u25C8 ' + fmtCredits(r.cost) + "</span></span>";
    }
    if (r.cost != null && r.costUnit === "plan") {
      return '<span class="qp-ts-item qp-ts-cost plan" title="\u5957\u9910\u62B5\u6263 ' + escHtml(fmtMoney(r.cost, "")) + ' \u989D\u5EA6"><span class="qp-ts-val">\u25A3 ' + fmtMoney(r.cost, "") + "</span></span>";
    }
    if (r.cost != null) {
      return '<span class="qp-ts-item qp-ts-cost cny" title="\u672C\u8F6E\u8D39\u7528\uFF08\u4EBA\u6C11\u5E01\uFF09"><span class="qp-ts-val">' + fmtMoney(r.cost, "\xA5") + "</span></span>";
    }
    if (r.afp != null && r.afp > 0) {
      return '<span class="qp-ts-item qp-ts-cost plan" title="\u5957\u9910\u62B5\u6263 ' + escHtml(fmtPlan(r.afp)) + ' \u989D\u5EA6"><span class="qp-ts-val">\u25A3 ' + fmtPlan(r.afp) + "</span></span>";
    }
    if (r.coefRange && r.afpLo != null) {
      return '<span class="qp-ts-item qp-ts-cost plan" title="Auto \u8DEF\u7531\u6D3B\u52A8\u671F\u5916\uFF1A\u5957\u9910\u62B5\u6263\u53C2\u8003\u533A\u95F4"><span class="qp-ts-val">\u25A3 ' + fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }) + "</span></span>";
    }
    if (r.tpRange && r.tpLo != null) {
      return '<span class="qp-ts-item qp-ts-cost credits" title="auto \u8DEF\u7531\uFF1A\u5168\u8868\u5F53\u524D\u65F6\u523B Credits \u53C2\u8003\u533A\u95F4"><span class="qp-ts-val">\u25C8 ' + fmtCredits(r.tpLo) + "~" + fmtCredits(r.tpHi) + "</span></span>";
    }
    return "";
  }
  function barModelHtml(model) {
    if (!model) return "";
    return '<span class="qp-ts-model" title="' + escHtml(model) + '">' + escHtml(model) + "</span>";
  }
  function buildRunningHtml(x) {
    if (x.replaying) return barState("\u56DE\u653E\u4E2D", ATTACH_TIP) + barItem("\u5DF2\u6062\u590D", fmtNum(x.replayTokens || 0) + " tok") + '<span class="qp-ts-more">\u8BE6\u60C5 \u2197</span>';
    return barState(x.attached ? "\u5DF2\u63A5\u5165" : "\u751F\u6210\u4E2D", x.attached ? ATTACH_TIP + "\uFF1B\u56DE\u653E " + fmtNum(x.replayTokens || 0) + " tok" : "\u5B9E\u65F6\u4F30\u7B97\uFF0C\u7ED3\u675F\u540E\u7531\u540E\u7AEF\u7528\u91CF\u6821\u51C6") + barModelHtml(x.model) + barItem("\u901F\u5EA6", fmtSpeed(x.speed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed") + barItem("\u8F93\u51FA", (x.tokenSource === "estimate" ? "\u2248" : "") + fmtNum(x.tokens) + '<small class="qp-ts-unit">tok</small>') + (x.pauseSec > 0.5 ? barItem("\u7B49\u5F85", fmtSec(x.pauseSec), "qp-ts-extra") : !x.attached ? barItem("\u9996\u5B57", fmtMs(x.ttft), "qp-ts-extra") : "") + costChipHtml(x) + '<span class="qp-ts-more">\u8BE6\u60C5 \u2197</span>';
  }
  function buildResultHtml(r) {
    var info = statusInfo(r, false);
    var total = r.outputTokens != null ? r.outputTokens : r.attached && r.totalGenerated ? r.totalGenerated : (r.tokens || 0) + (r.toolTokens || 0);
    var html = barState(r.attached ? "\u5DF2\u63A5\u5165" : info.text, info.tip + (r.attached ? "\uFF1B" + ATTACH_TIP + "\uFF1B\u56DE\u653E " + fmtNum(r.replayTokens || 0) + " tok" : ""));
    html += barModelHtml(r.model);
    if (r.genSpeed > 0 && !r.historyOnly) html += barItem("\u751F\u6210", fmtSpeed(r.genSpeed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed");
    html += barItem("\u8F93\u51FA", (r.tokenSource === "estimate" ? "\u2248" : "") + fmtNum(total) + '<small class="qp-ts-unit">tok</small>', "", "\u672C\u8F6E\u8F93\u51FA\u603B\u91CF\uFF0C\u542B\u6B63\u6587\u3001\u601D\u8003\u548C\u5DE5\u5177\u53C2\u6570");
    if (r.secondsKnown !== false && r.seconds != null) html += barItem(r.originKnown === false ? "\u89C2\u5BDF" : "\u8017\u65F6", fmtSec(r.seconds), "qp-ts-extra");
    html += costChipHtml(r);
    return html + '<span class="qp-ts-more">\u8BE6\u60C5 \u2197</span>';
  }
  function setBar(cls, html) {
    var bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.className = cls;
    bar.innerHTML = html;
  }
  var lastRunRender = 0;
  function renderRunning(x) {
    var t = now();
    if (t - lastRunRender < RENDER_MIN_GAP) return;
    lastRunRender = t;
    setBar("running", buildRunningHtml(x));
  }
  function renderReplay(st) {
    if (st.__sid !== getSessionId()) return;
    var t = now();
    if (t - lastRunRender < RENDER_MIN_GAP) return;
    lastRunRender = t;
    setBar("running", buildRunningHtml({
      replaying: true,
      attached: true,
      ttft: 0,
      speed: 0,
      tokens: st.replayTokens,
      replayTokens: st.replayTokens,
      pauseSec: st.pauseMs / 1e3
    }));
  }
  function renderDone(r) {
    setBar(r.status === DONE ? "done" : r.status, buildResultHtml(r));
    renderer.refreshDetail(r);
  }
  function renderWaiting() {
    setBar("running", buildWaitingHtml());
  }
  renderer.renderRunning = renderRunning;
  renderer.renderReplay = renderReplay;
  renderer.renderDone = renderDone;
  renderer.renderWaiting = renderWaiting;

  // src/ui-panel.js
  var AVG_TIP = "\u5E73\u5747 = \u6B63\u6587\u4E0E\u601D\u8003 token \xF7 \u89C2\u5BDF\u65F6\u957F\uFF08\u542B\u9996\u5B57\u548C\u5DE5\u5177\u7B49\u5F85\uFF09\uFF1B\u5DE5\u5177\u53C2\u6570\u5305\u542B\u5728\u8F93\u51FA\u603B\u91CF\u4E2D\uFF0C\u4F46\u4E0D\u8BA1\u5165\u6B64\u901F\u5EA6\u3002\u6D41\u5F0F\u901F\u5EA6\u7531\u5B57\u7B26\u4F30\u7B97\uFF0C\u540E\u7AEF\u7528\u91CF\u5230\u8FBE\u540E\u6309\u6BD4\u4F8B\u6821\u51C6\uFF0C\u5C5E\u4E8E\u89C2\u6D4B\u901F\u7387\u3002\u4E2D\u9014\u63A5\u5165\u4EC5\u8BA1\u63A5\u5165\u540E\u7684\u901F\u5EA6\u3002";
  function segSpeed(s) {
    var dt = (s.t1 - s.t0) / 1e3;
    return dt > 0.05 ? measuredSegTokens(s) / dt : 0;
  }
  function buildDetailChart(segs) {
    var sourceIndices = [];
    segs = (segs || []).filter(function(segment, index) {
      var valid = segment.t1 - segment.t0 > 50 && measuredSegTokens(segment) > 0;
      if (valid) sourceIndices.push(index + 1);
      return valid;
    });
    if (!segs || segs.length < 2) {
      return '<div class="qp-d-empty">\u53EF\u6D4B\u901F\u5206\u6BB5\u4E0D\u8DB3 \xB7 \u9700\u8981 2 \u6BB5\u6709\u6548\u5305\u95F4\u6837\u672C\u624D\u7ED8\u5236\u8D8B\u52BF\uFF1B\u5355\u5305\u4E0E\u8FC7\u77ED\u5206\u6BB5\u4E0D\u63A8\u7B97\u901F\u5EA6\u3002</div>';
    }
    var W = 560, H = 176, PL = 46, PR = 18, PT = 18, PB = 28;
    var speeds = segs.map(segSpeed);
    var max = Math.max.apply(null, speeds.concat([1]));
    var n = segs.length;
    function x(i) {
      return PL + (n === 1 ? 0 : i * (W - PL - PR) / (n - 1));
    }
    function y(v) {
      return H - PB - v / max * (H - PT - PB);
    }
    var pts = speeds.map(function(v, i) {
      return [x(i), y(v)];
    });
    var path = pts.map(function(p, i) {
      return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    }).join(" ");
    var grid = "";
    [0, 0.5, 1].forEach(function(f) {
      var gy = y(max * f).toFixed(1);
      var label = (max * f).toFixed(max >= 100 ? 0 : 1);
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/><text x="' + (PL - 6) + '" y="' + gy + '" fill="#7d8ca3" font-size="10" text-anchor="end" dominant-baseline="middle">' + label + "</text>";
    });
    var axis = '<text x="' + x(0) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[0] + '</text><text x="' + x(n - 1) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[n - 1] + "</text>";
    if (n >= 6) {
      var mid = Math.floor((n - 1) / 2);
      axis += '<text x="' + x(mid) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[mid] + "</text>";
    }
    var dots = pts.map(function(p, i) {
      var s = segs[i];
      var tip = "\u6BB5" + sourceIndices[i] + "\uFF1A\u603B\u91CF " + Math.round(s.tokens) + " tok\uFF1B\u6D4B\u901F\u589E\u91CF " + Math.round(measuredSegTokens(s)) + " tok / " + ((s.t1 - s.t0) / 1e3).toFixed(1) + "s = " + speeds[i].toFixed(1) + " tok/s\uFF08\u6392\u9664\u9996\u5305\u548C\u7F13\u51B2\u51B2\u5237\uFF09";
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (i === n - 1 ? 3.5 : 2.5) + '" fill="' + (i === n - 1 ? "#ffd479" : "rgba(127,231,196,0.85)") + '"><title>' + tip + "</title></circle>";
    }).join("");
    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="\u5404\u6709\u6548\u5206\u6BB5\u751F\u6210\u901F\u5EA6\u8D8B\u52BF\uFF0C\u5355\u4F4D tok/s">' + grid + '<path d="' + path + '" stroke="rgba(143,184,255,0.75)" stroke-width="1.5" fill="none"/>' + dots + axis + "</svg>";
  }
  function buildSparkline(hist) {
    if (!hist || hist.length < 2) return "";
    var W = 220, H = 40, max = 1, i;
    for (i = 0; i < hist.length; i++) if (hist[i][1] > max) max = hist[i][1];
    var t0 = hist[0][0], span = Math.max(1, hist[hist.length - 1][0] - t0);
    var pts = hist.map(function(p) {
      return [(p[0] - t0) / span * W, H - 4 - p[1] / max * (H - 10)];
    });
    var d = pts.map(function(p, j) {
      return (j ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    }).join(" ");
    return '<svg class="qp-spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + " L" + W + "," + H + " L0," + H + ' Z" fill="rgba(127,231,196,0.10)"/><path d="' + d + '" fill="none" stroke="#7fe7c4" stroke-width="1.5"/></svg>';
  }
  function billingCardHtml(r) {
    var label, num, cap, cls = "";
    if (r.cost != null && r.costUnit === "credits") {
      cls = " credits";
      label = 'Credits \u6D88\u8017<span class="qp-d-tag">Token Plan</span>';
      num = fmtCredits(r.cost) + "<small>credits</small>";
      cap = "\u2248" + fmtMoney(creditsToCny(r.cost), "\xA5") + " \u520A\u4F8B\u4EF7";
      var tierId = tpTierPref(), plan = null;
      for (var i = 0; i < TP_PLANS.length; i++) if (TP_PLANS[i].id === tierId) plan = TP_PLANS[i];
      if (plan) cap += " \xB7 \u6309 " + plan.name + " \u644A\u9500 \u2248" + fmtMoney(r.cost * plan.price / plan.quota, "\xA5");
      if (r.tp && r.tp.factor < 1) cap = '<span class="qp-d-disc">' + escHtml(r.tp.factorNote || "\u6298\u6263\u751F\u6548") + "</span>" + cap;
    } else if (r.cost != null && r.costUnit === "plan") {
      label = "\u5957\u9910\u62B5\u6263";
      num = fmtMoney(r.cost, "") + "<small>\u989D\u5EA6</small>";
      cap = escHtml(channelLabel(r.channel));
    } else if (r.cost != null) {
      label = "\u672C\u8F6E\u8D39\u7528";
      num = fmtMoney(r.cost, "\xA5");
      cap = escHtml(channelLabel(r.channel));
      if (r.channel === "deepseek") {
        var t = priceTableFor(r.model);
        if (t) cap += " \xB7 " + (isPeakHour(t) ? "\u5C16\u5CF0\u65F6\u6BB5" : "\u4F4E\u8C37\u65F6\u6BB5");
      }
    } else if (r.afp != null && r.afp > 0) {
      label = "\u5957\u9910\u62B5\u6263";
      num = fmtPlan(r.afp) + "<small>\u989D\u5EA6</small>";
      cap = "\u7CFB\u6570\u8BA1\u8D39 \xB7 " + escHtml(channelLabel(r.channel));
    } else if (r.coefRange && r.afpLo != null) {
      label = "\u5957\u9910\u62B5\u6263 \xB7 \u53C2\u8003";
      num = fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }) + "<small>\u989D\u5EA6</small>";
      cap = "Auto \u8DEF\u7531 \xB7 \u6D3B\u52A8\u671F\u5916\u53C2\u8003\u533A\u95F4";
    } else if (r.tpRange && r.tpLo != null) {
      cls = " credits";
      label = "Credits \xB7 \u53C2\u8003";
      num = fmtCredits(r.tpLo) + "~" + fmtCredits(r.tpHi) + "<small>credits</small>";
      cap = "auto \u8DEF\u7531 \xB7 \u5168\u8868\u5F53\u524D\u65F6\u523B\u533A\u95F4";
    } else {
      label = "\u8BA1\u8D39";
      num = "\u2014";
      cap = r.coefMissing ? "\u7CFB\u6570\u672A\u77E5" : r.priceMissing ? "\u65E0\u4EF7\u8868" : "\u6E20\u9053\u672A\u8BC6\u522B";
    }
    return '<div class="qp-d-card bill' + cls + '"><div class="qp-d-label">' + label + '</div><div class="qp-d-number">' + num + '</div><div class="qp-d-caption">' + cap + "</div></div>";
  }
  function tpBreakdownHtml(r) {
    if (!r.tp) return "";
    var t = r.tp, sum = Math.max(t.input + t.cache + t.output, 1e-9);
    function bar(label, v, cls) {
      var pct = Math.max(2, Math.round(v / sum * 100));
      return '<div class="qp-tp-row"><span class="qp-tp-l">' + label + '</span><span class="qp-tp-track"><span class="qp-tp-fill ' + cls + '" style="width:' + pct + '%"></span></span><span class="qp-tp-v">' + fmtCredits(v) + "</span></div>";
    }
    var notes = [];
    if (t.tierIdx > 0) notes.push("\u8F93\u5165\u8D85\u9636\u68AF\u9608\u503C\uFF0C\u6309\u7B2C " + (t.tierIdx + 1) + " \u6863\u8BA1\u4EF7");
    if (t.cacheAssumed) notes.push("\u7F13\u5B58\u547D\u4E2D\u5355\u4EF7\u672A\u516C\u5E03\uFF0C\u6309\u8F93\u5165\u4EF7\u4F30\u7B97");
    if (t.assumedBase) notes.push("\u9884\u89C8\u7248\u65E0\u72EC\u7ACB\u520A\u4F8B\u4EF7\uFF0C\u6309 qwen4-max \u520A\u4F8B\u4EF7\u4F30\u7B97");
    return '<div class="qp-d-section">Credits \u6784\u6210<small>\u8F93\u5165 / \u7F13\u5B58 / \u8F93\u51FA \xB7 \u4E09\u5206\u91CF</small></div><div class="qp-tp">' + bar("\u8F93\u5165", t.input, "in") + bar("\u7F13\u5B58", t.cache, "ca") + bar("\u8F93\u51FA", t.output, "out") + (notes.length ? '<div class="qp-tp-note">' + escHtml(notes.join("\uFF1B")) + "</div>" : "") + "</div>";
  }
  function tpTierPref() {
    try {
      return localStorage.getItem("qp_token_speed_tp_tier") || "";
    } catch (e) {
      return "";
    }
  }
  function ledgerHtml() {
    var s = ledgerToday();
    if (!s.turns) return "";
    var parts = ["<span>" + s.turns + " \u56DE\u5408</span>", "<span>\u8F93\u51FA " + fmtNum(s.out) + " tok</span>"];
    if (s.credits > 0) parts.push('<span class="qp-lg-cr">\u25C8 ' + fmtCredits(s.credits) + " credits</span>");
    if (s.cny > 0) parts.push('<span class="qp-lg-cny">' + fmtMoney(s.cny, "\xA5") + "</span>");
    if (s.plan > 0) parts.push('<span class="qp-lg-plan">\u25A3 ' + fmtPlan(s.plan) + " \u989D\u5EA6</span>");
    var tierSel = "";
    if (s.credits > 0) {
      var cur = tpTierPref(), plan = null, i;
      for (i = 0; i < TP_PLANS.length; i++) if (TP_PLANS[i].id === cur) plan = TP_PLANS[i];
      var opts = '<option value="">\u4E0D\u644A\u9500</option>';
      for (i = 0; i < TP_PLANS.length; i++) {
        var p = TP_PLANS[i];
        opts += '<option value="' + p.id + '"' + (cur === p.id ? " selected" : "") + ">" + p.name + " \xA5" + p.price + "/\u6708</option>";
      }
      tierSel = '<select id="qp-tp-tier" class="qp-tp-select" title="\u9009\u62E9\u4F60\u7684 Token Plan \u6863\u4F4D\uFF0C\u6309\u8BA2\u9605\u5B9E\u9645\u6210\u672C\u644A\u9500\u4ECA\u65E5 credits">' + opts + "</select>";
      if (plan) parts.push('<span class="qp-lg-amort">\u6309 ' + plan.name + " \u644A\u9500 \u2248" + fmtMoney(s.credits * plan.price / plan.quota, "\xA5") + "</span>");
    }
    var models = Object.keys(s.byModel).sort(function(a, b) {
      return (s.byModel[b].out || 0) - (s.byModel[a].out || 0);
    }).slice(0, 3);
    var mhtml = models.map(function(m) {
      var b = s.byModel[m];
      return '<span class="qp-lg-m" title="' + b.turns + " \u56DE\u5408 \xB7 \u8F93\u51FA " + Math.round(b.out) + ' tok">' + escHtml(m) + " \xB7 " + fmtNum(b.out) + "</span>";
    }).join("");
    return '<div class="qp-d-section">\u4ECA\u65E5\u6D88\u8017<small>\u672C\u5730\u8D26\u672C \xB7 \u4EC5\u672C\u673A\u7EDF\u8BA1</small>' + tierSel + '</div><div class="qp-lg"><div class="qp-lg-sum">' + parts.join("") + "</div>" + (mhtml ? '<div class="qp-lg-models">' + mhtml + "</div>" : "") + "</div>";
  }
  function buildDetailHead(r) {
    var segs = r.segments || [], running = r.status === "running", info = statusInfo(r, running);
    var total = r.outputTokens != null ? r.outputTokens : r.attached ? r.totalGenerated || (r.tokens || 0) + (r.toolTokens || 0) + (r.replayTokens || 0) : (r.tokens || 0) + (r.toolTokens || 0);
    var estimated = r.tokenSource === "estimate", speed = running ? r.speed : r.genSpeed;
    function row(label, value, tip) {
      return '<div class="qp-c"' + (tip ? ' title="' + escHtml(tip) + '"' : "") + '><span class="qp-cl">' + label + '</span><span class="qp-cv">' + value + "</span></div>";
    }
    function time(label, value, tip) {
      return '<div class="qp-d-time" title="' + escHtml(tip || "") + '"><span>' + label + "</span><strong>" + value + "</strong></div>";
    }
    function waitValue(value) {
      return r.historyOnly || value == null ? "\u2014" : value <= 0 ? "0.0s" : fmtSec(value);
    }
    var note = r.attached ? '<div class="qp-d-note" title="' + ATTACH_TIP + '">\u4E2D\u9014\u63A5\u5165 \xB7 \u56DE\u653E ' + fmtNum(r.replayTokens || 0) + " tok \u4E0D\u8BA1\u901F</div>" : "";
    if (!running && r.status !== DONE) note += '<div class="qp-d-note">' + escHtml(r.errMsg || info.tip) + "</div>";
    var usage = row("\u8F93\u5165\u7528\u91CF", r.promptTokens != null ? fmtNum(r.promptTokens) + " tok" : "\u2014", "\u540E\u7AEF\u8BB0\u5F55\u7684\u672C\u8F6E\u7D2F\u8BA1\u8F93\u5165\u7528\u91CF\uFF0C\u53EF\u80FD\u5305\u542B\u591A\u6B21\u5DE5\u5177\u7EED\u8F6E") + row("\u8F93\u5165 + \u8F93\u51FA", r.total ? fmtNum(r.total) + " tok" : "\u2014", "\u540E\u7AEF\u672C\u8F6E\u7D2F\u8BA1\u603B\u7528\u91CF\uFF0C\u4E0D\u7B49\u4E8E\u65B0\u589E\u8F93\u51FA\u91CF") + row("\u5DE5\u5177\u53C2\u6570 \xB7 \u542B\u5728\u8F93\u51FA\u5185", r.toolTokens > 0 ? "\u2248" + fmtNum(r.toolTokens) + " tok" : "\u2014", "\u5DE5\u5177\u53C2\u6570\u662F\u8F93\u51FA\u7684\u4E00\u90E8\u5206\uFF1B\u62C6\u5206\u91CF\u4E3A\u6821\u51C6\u540E\u7684\u4F30\u7B97\uFF0C\u4E0D\u4E0E\u8F93\u51FA\u603B\u91CF\u91CD\u590D\u76F8\u52A0") + row("\u7F13\u5B58\u547D\u4E2D \xB7 \u542B\u5728\u8F93\u5165\u5185", r.cacheHit > 0 ? fmtNum(r.cacheHit) + " tok" : "\u2014");
    if (r.afp != null && r.afp > 0) usage += row("\u5957\u9910\u62B5\u6263", fmtPlan(r.afp) + " \u989D\u5EA6", channelTip(r.channel, r.provider)) + row("\u5176\u4E2D\u7F13\u5B58\u91CD\u8BA1", rebillNote(r.channel, r.cacheHit, r.model).replace(/[（）]/g, "").replace("\u7F13\u5B58\u91CD\u8BA1 ", "") || "\u2014");
    if (r.cost != null) usage += r.costUnit === "plan" ? row("\u5957\u9910\u62B5\u6263", fmtMoney(r.cost, "") + " \u989D\u5EA6", channelTip(r.channel, r.provider)) : r.costUnit === "credits" ? row("Credits \u6D88\u8017", fmtCredits(r.cost) + " credits", channelTip(r.channel, r.provider)) : row("\u8D39\u7528", fmtMoney(r.cost, "\xA5"), channelTip(r.channel, r.provider));
    if (r.coefRange && r.afpLo != null) usage += row("\u5957\u9910\u62B5\u6263 \xB7 \u53C2\u8003", fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }), ALIAS_TIP);
    if (r.tpRange && r.tpLo != null) usage += row("Credits \xB7 \u53C2\u8003", fmtCredits(r.tpLo) + "~" + fmtCredits(r.tpHi) + " credits", "auto \u667A\u80FD\u8DEF\u7531\u5E95\u5C42\u6A21\u578B\u4E0D\u5B9A\uFF0C\u6309\u5168\u8868\u5F53\u524D\u65F6\u523B\u7ED9\u53C2\u8003\u533A\u95F4");
    if (r.coefMissing || r.priceMissing || !r.channel) usage += row("\u8BA1\u8D39", r.coefMissing ? "\u7CFB\u6570\u672A\u77E5" : r.priceMissing ? "\u65E0\u4EF7\u8868" : "\u6E20\u9053\u672A\u8BC6\u522B", channelTip(r.channel, r.provider));
    var observed = !r.historyOnly && speed > 0;
    var speedNote = r.historyOnly ? "\u5386\u53F2\u4EC5\u6062\u590D\u7528\u91CF\uFF0C\u672A\u89C2\u6D4B\u751F\u6210\u901F\u5EA6" : r.attached ? "\u4EC5\u7EDF\u8BA1\u63A5\u5165\u540E\u6709\u6548\u751F\u6210\uFF0C\u56DE\u653E\u4E0D\u8BA1\u901F" : "\u6392\u9664\u9996\u5B57\u3001\u5DE5\u5177\u7B49\u5F85\u53CA\u7F13\u51B2\u51B2\u5237";
    var burnHtml = "";
    if (running && r.burnRate && r.burnRate.value > 0) {
      burnHtml = '<div class="qp-d-burn">\u71C3\u70E7\u7387 \u2248' + (r.burnRate.unit === "credits/min" ? fmtCredits(r.burnRate.value) + " credits/min" : fmtMoney(r.burnRate.value, "\xA5") + "/h") + "</div>";
    }
    var sparkHtml = running ? buildSparkline(r.speedHist) : "";
    var html = '<div class="qp-d-title"><div><div class="qp-d-eyebrow">TOKEN SPEED</div><div class="qp-d-heading" id="qp-d-heading">\u672C\u8F6E\u751F\u6210\u6982\u89C8</div><div class="qp-d-meta">' + escHtml(r.model || "\u672A\u77E5\u6A21\u578B") + (r.aliasModel ? " \xB7 Auto" : "") + " \xB7 " + channelLabel(r.channel) + (fmtAge(r) ? " \xB7 " + fmtAge(r) : "") + '</div></div><div class="qp-d-tools"><span class="qp-d-badge ' + escHtml(r.status) + '" title="' + escHtml(info.tip) + '">' + info.text + '</span><button type="button" class="qp-d-close" id="qp-d-close" aria-label="\u5173\u95ED\u751F\u6210\u8BE6\u60C5">\xD7</button></div></div>' + note + '<div class="qp-d-hero"><div class="qp-d-card speed"><div class="qp-d-label">' + (running ? "\u5B9E\u65F6\u751F\u6210\u901F\u5EA6" : "\u6709\u6548\u751F\u6210\u901F\u5EA6") + '<span class="qp-d-tag">' + (r.historyOnly ? "\u672A\u89C2\u6D4B" : "\u89C2\u6D4B\u4F30\u7B97") + '</span></div><div class="qp-d-number">' + (observed ? fmtSpeed(speed) : "\u2014") + "<small>tok/s</small></div>" + sparkHtml + '<div class="qp-d-caption">' + speedNote + "</div>" + burnHtml + '</div><div class="qp-d-card"><div class="qp-d-label">\u672C\u8F6E\u8F93\u51FA<span class="qp-d-tag">' + (estimated ? "\u4F30\u7B97" : "\u540E\u7AEF\u7528\u91CF") + '</span></div><div class="qp-d-number" title="' + Math.round(total).toLocaleString("zh-CN") + ' tok">' + (estimated ? "\u2248" : "") + fmtNum(total) + '<small>tok</small></div><div class="qp-d-caption">\u542B\u6B63\u6587\u3001\u601D\u8003\u4E0E\u5DE5\u5177\u53C2\u6570</div></div>' + billingCardHtml(r) + '</div><div class="qp-d-timings">' + time("\u9996\u5B57\u7B49\u5F85", r.attached || r.historyOnly ? "\u2014" : fmtMs(r.ttft), "\u4ECE\u63D0\u4EA4\u8BF7\u6C42\u5230\u9996\u4E2A\u8F93\u51FA\u5230\u8FBE") + time("\u5DE5\u5177 / \u7A7A\u95F2\u7B49\u5F85", waitValue(r.pauseSec), "\u5DF2\u89C2\u6D4B\u5DE5\u5177\u6267\u884C\u4E0E\u6BB5\u95F4\u7A7A\u95F2\u7B49\u5F85") + time("\u5DE5\u5177\u540E\u6A21\u578B\u7B49\u5F85", waitValue(r.modelWaitSec), "\u5DE5\u5177\u7ED3\u675F\u5230\u4E0B\u4E00\u6B21\u6B63\u6587\u6216\u601D\u8003\u5230\u8FBE\uFF0C\u5355\u5217\u8BB0\u5F55") + time(r.originKnown === false ? "\u63A5\u5165\u540E\u89C2\u5BDF" : "\u603B\u8017\u65F6", r.secondsKnown === false || r.seconds == null ? "\u2014" : fmtSec(r.seconds), "\u4ECE\u8BF7\u6C42\u5F00\u59CB\u5230\u7ED3\u675F\uFF1B\u4E2D\u9014\u63A5\u5165\u65F6\u4E3A\u5DF2\u89C2\u6D4B\u65F6\u957F") + '</div><div class="qp-d-section">\u7528\u91CF\u4E0E\u8BA1\u8D39<small>\u62C6\u5206\u9879\u5DF2\u5305\u542B\u5728\u603B\u91CF\u5185</small></div><div class="qp-d-usage">' + usage + "</div>" + tpBreakdownHtml(r) + ledgerHtml() + '<div class="qp-d-explain">' + (estimated ? "\u2248 \u8868\u793A\u4F30\u7B97\u3002\u8F93\u51FA\u603B\u91CF\u5728\u540E\u7AEF\u7528\u91CF\u5230\u8FBE\u540E\u6821\u51C6\uFF1B\u901F\u5EA6\u4E0E\u8F93\u51FA\u62C6\u5206\u4ECD\u4E3A\u89C2\u6D4B\u4F30\u7B97\u3002" : "\u8F93\u51FA\u603B\u91CF\u53D6\u540E\u7AEF\u7528\u91CF\uFF1B\u5E26 \u2248 \u7684\u901F\u5EA6\u4E0E\u62C6\u5206\u9879\u4E3A\u89C2\u6D4B\u4F30\u7B97\u3002") + "</div>";
    if (!r.historyOnly) html += '<div class="qp-d-section">\u751F\u6210\u5206\u6BB5<small title="' + escHtml(AVG_TIP) + '">' + segs.length + " \u6BB5" + (r.peak > 0 ? " \xB7 \u5CF0\u503C " + fmtSpeed(r.peak) + " tok/s" : "") + (r.avg > 0 ? " \xB7 \u5168\u7A0B\u5747\u901F " + fmtSpeed(r.avg) + " tok/s" : "") + '</small></div><div class="qp-d-chart">' + buildDetailChart(segs) + "</div>";
    if (segs.length) html += '<div class="qp-d-segtitle"><span>\u5206\u6BB5</span><span>\u8F93\u51FA\u91CF \u2248</span><span>\u6709\u6548\u65F6\u957F</span><span>\u751F\u6210\u901F\u5EA6 \u2248</span></div>';
    return html;
  }
  function segRowHtml(s, i, isCur) {
    return '<span class="qp-ri">#' + (i + 1) + '</span><span class="qp-rt">' + Math.round(s.tokens) + ' tok</span><span class="qp-rd">' + ((s.t1 - s.t0) / 1e3).toFixed(1) + 's</span><span class="qp-rs" title="\u901F\u5EA6\u4EC5\u6309\u5305\u95F4\u589E\u957F\u8BA1\u7B97\uFF0C\u6392\u9664\u9996\u5305\u548C\u7F13\u51B2\u51B2\u5237\uFF1B\u603B\u91CF\u4ECD\u5305\u542B\u5168\u90E8\u8F93\u51FA">' + (s.t1 - s.t0 > 50 && measuredSegTokens(s) > 0 ? "\u2248" + segSpeed(s).toFixed(1) + " tok/s" : "\u2014") + "</span>";
  }
  function appendSegRow(box, s, i, isCur) {
    var row = document.createElement("div");
    row.className = "qp-d-row" + (isCur ? " qp-d-cur" : "");
    row.innerHTML = segRowHtml(s, i, isCur);
    box.appendChild(row);
  }
  function syncSegs(box, segs, live) {
    var n0 = box.children ? box.children.length : 0;
    if (segs.length < n0) {
      box.innerHTML = "";
      n0 = 0;
    }
    for (var i = n0; i < segs.length; i++) {
      appendSegRow(box, segs[i], i, live && i === segs.length - 1);
    }
    for (var j = 0; j < segs.length; j++) {
      var row = box.children && box.children[j];
      if (!row) continue;
      var current = !!live && j === segs.length - 1;
      var html = segRowHtml(segs[j], j, current);
      if (row.innerHTML !== html) row.innerHTML = html;
      row.className = "qp-d-row" + (current ? " qp-d-cur" : "");
    }
  }
  var detailTimer = null;
  var detailSig = "";
  function detailIsLive(sid) {
    var st = getActiveStream(sid);
    return !!(st && st.tFirst);
  }
  function detailSignature(sid) {
    var st = getActiveStream(sid);
    if (st && st.tFirst) {
      return [
        "L",
        sid,
        st.tokenCount,
        st.toolTokens,
        st.segments ? st.segments.length : 0,
        Math.round((st.currentSeg ? st.currentSeg.tokens : 0) / 20),
        Math.round(st.pauseMs / 1e3),
        Math.round((now() - st.t0) / 1e3),
        st.attached ? 1 : 0,
        st.replayTokens || 0,
        Math.round((st.peakMax || 0) / 5),
        Math.round(st.lastSpeed || 0)
      ].join("|");
    }
    var rr = loadLastResult(sid);
    return rr ? ["D", sid, rr.ts || 0, rr.status || "", (rr.segments || []).length].join("|") : "E|" + sid;
  }
  function liveSnapshot(st) {
    var segs = st.segments.slice();
    if (st.currentSeg && st.currentSeg.tokens > 0) segs.push(st.currentSeg);
    var _replayN = st.attached ? st.replayTokens || 0 : 0;
    var _liveEl = st.attached && st.liveStartT ? (now() - st.liveStartT) / 1e3 : (now() - st.t0) / 1e3;
    var _costTok = st.tokenCount + (st.toolTokens || 0) + _replayN;
    var _ch = channelOf(st);
    var _money = moneyFields(_ch, st.model, st.promptTokens, _costTok, st.cacheHitTokens);
    return {
      model: st.model,
      status: "running",
      ttft: st.attached ? 0 : st.ttft,
      promptTokens: st.promptTokens,
      tokens: st.tokenCount,
      toolTokens: st.toolTokens || 0,
      total: st.totalTokens,
      outputTokens: _costTok,
      tokenSource: "estimate",
      seconds: (now() - st.t0) / 1e3,
      genTime: 0,
      genSpeed: 0,
      pauseSec: observedWaitMs(st) / 1e3,
      modelWaitSec: (st.modelWaitMs + (st.toolResumeAt ? Math.max(0, now() - st.toolResumeAt) : 0)) / 1e3,
      speed: st.lastSpeed || 0,
      segments: segs,
      cacheHit: st.cacheHitTokens || 0,
      cost: _money.cost,
      afp: _money.afp,
      costUnit: _money.costUnit,
      channel: _money.channel,
      channelSrc: st.channelSrc || "",
      provider: st.provider || _money.provider,
      coefMissing: _money.coefMissing,
      priceMissing: _money.priceMissing,
      aliasModel: _money.aliasModel,
      afpLo: _money.afpLo,
      afpHi: _money.afpHi,
      coefRange: _money.coefRange,
      // TokenPlan 明细 / auto 区间 / 燃烧率 / sparkline 采样
      tp: _money.tp,
      tpLo: _money.tpLo,
      tpHi: _money.tpHi,
      tpRange: _money.tpRange,
      burnRate: burnRateOf(_ch, st.model, st.lastSpeed || 0, st.promptTokens),
      speedHist: st.speedHist ? st.speedHist.slice() : [],
      // 不变量——峰值不可能低于平均（与 endTurn 同款兜底；此处 avg/peak 同为 wall-clock 口径）
      peak: Math.max(st.peakMax || 0, _liveEl > 0.1 ? st.tokenCount / _liveEl : 0),
      avg: _liveEl > 0.1 ? st.tokenCount / _liveEl : 0,
      ts: 0,
      attached: st.attached,
      replayTokens: _replayN,
      totalGenerated: st.attached ? st.totalGenerated || _costTok : 0
    };
  }
  function bindDetailClose(p) {
    var c = document.getElementById("qp-d-close");
    if (c && c.addEventListener) {
      c.addEventListener("click", function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        closeDetail();
      });
    }
  }
  function bindTierSelect() {
    var sel = document.getElementById("qp-tp-tier");
    if (!sel || !sel.addEventListener) return;
    sel.addEventListener("change", function() {
      try {
        localStorage.setItem("qp_token_speed_tp_tier", sel.value || "");
      } catch (e) {
      }
      var sid = getSessionId(), st = getActiveStream(sid);
      refreshDetail(st && st.tFirst ? liveSnapshot(st) : loadLastResult(sid));
    });
  }
  function paintDetail(p, snap, live) {
    var top = p.scrollTop || 0;
    if (!p.querySelector(".qp-d-head")) {
      p.innerHTML = "";
      var hd = document.createElement("div");
      hd.className = "qp-d-head";
      p.appendChild(hd);
      var bx = document.createElement("div");
      bx.className = "qp-d-segs";
      bx.id = "qp-d-segs";
      p.appendChild(bx);
    }
    var headEl = p.querySelector(".qp-d-head");
    if (headEl) headEl.innerHTML = buildDetailHead(snap);
    bindDetailClose(p);
    bindTierSelect();
    var box = p.querySelector(".qp-d-segs");
    if (box) syncSegs(box, snap.segments || [], !!live);
    p.scrollTop = top;
  }
  function refreshDetail(forceR) {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var sid = getSessionId();
    var sig = detailSignature(sid);
    if (!forceR && sig === detailSig) return;
    var live = detailIsLive(sid);
    var snap = forceR || (live ? liveSnapshot(getActiveStream(sid)) : loadLastResult(sid));
    if (!snap) {
      closeDetail();
      return;
    }
    detailSig = sig;
    paintDetail(p, snap, live);
  }
  function onDetailKeydown(e) {
    if (e && (e.key === "Escape" || e.keyCode === 27)) closeDetail();
  }
  function closeDetail() {
    if (detailTimer) {
      clearInterval(detailTimer);
      detailTimer = null;
    }
    detailSig = "";
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    document.removeEventListener("click", onDocClickDetail, true);
    document.removeEventListener("keydown", onDetailKeydown, true);
  }
  function onDocClickDetail(e) {
    var p = document.getElementById(PANEL_ID);
    if (p && !p.contains(e.target)) closeDetail();
  }
  function openDetail(r) {
    closeDetail();
    var p = document.createElement("div");
    p.id = PANEL_ID;
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-labelledby", "qp-d-heading");
    p.addEventListener("click", function(e) {
      e.stopPropagation();
    });
    document.body.appendChild(p);
    paintDetail(p, r, !!(r && r.status === "running"));
    detailSig = detailSignature(getSessionId());
    setTimeout(function() {
      if (document.getElementById(PANEL_ID)) document.addEventListener("click", onDocClickDetail, true);
    }, 0);
    document.addEventListener("keydown", onDetailKeydown, true);
    detailTimer = setInterval(function() {
      if (!document.getElementById(PANEL_ID)) {
        clearInterval(detailTimer);
        detailTimer = null;
        return;
      }
      try {
        refreshDetail();
      } catch (e) {
      }
    }, 600);
  }
  function onBarClick(e) {
    e.stopPropagation();
    if (document.getElementById(PANEL_ID)) {
      closeDetail();
      return;
    }
    var sid = getSessionId();
    var st = getActiveStream(sid);
    if (st && st.tFirst) {
      openDetail(liveSnapshot(st));
      return;
    }
    var r = loadLastResult(sid);
    if (r) openDetail(r);
  }
  renderer.refreshDetail = refreshDetail;

  // src/ui-mount.js
  function isOnChatPage() {
    return !!document.querySelector(
      ".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input'], .qwenpaw-chat-anywhere-message-list, .qwenpaw-bubble-list-scroll"
    );
  }
  function positionBar() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) return;
    if (!isOnChatPage()) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    var inputBox = document.querySelector(".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input']");
    if (inputBox) {
      var rect = inputBox.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.top > 0) {
        bar.style.bottom = Math.max(64, window.innerHeight - rect.top + 6) + "px";
        var cx = rect.left + rect.width / 2;
        var half = bar.offsetWidth / 2;
        if (half > 0) cx = Math.max(half + 4, Math.min(cx, window.innerWidth - half - 4));
        bar.style.left = cx + "px";
        bar.style.transform = "translateX(-50%)";
        return;
      }
    }
    warnOnce("anchor", "\u804A\u5929\u9875\u4E0A\u627E\u4E0D\u5230\u8F93\u5165\u6846\u5BB9\u5668\uFF08.qwenpaw-chat-anywhere-input\uFF09\uFF0C\u60AC\u6D6E\u6761\u4F4D\u7F6E\u56DE\u9000\u9ED8\u8BA4\u2014\u2014QwenPaw \u524D\u7AEF\u53EF\u80FD\u5DF2\u6539\u7248");
    bar.style.bottom = "96px";
    bar.style.left = "50%";
    bar.style.transform = "translateX(-50%)";
  }
  function insideChatOrPlugin(el) {
    try {
      for (var p = el, i = 0; p && i < 8; i++, p = p.parentElement) {
        if (p.id === BAR_ID || p.id === PANEL_ID) return true;
        var cls = typeof p.className === "string" ? p.className : "";
        if (!cls) continue;
        if (cls.indexOf("qp-") >= 0) return true;
        if (/(bubble|markdown|message|prose|chat-|assistant|user-)/i.test(cls)) return true;
      }
    } catch (e) {
    }
    return false;
  }
  var anchorHidden = false;
  function resetAnchorScan() {
    anchorHidden = false;
  }
  function hideAnchor(force) {
    if (anchorHidden && !force) return;
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n2) {
          var t = n2.textContent || "";
          return t.indexOf("\u61C2\u4F60\u6240\u9700") >= 0 || t.indexOf("\u4F34\u4F60\u5DE6\u53F3") >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var n, hid = false;
      while (n = walker.nextNode()) {
        var el = n.parentElement;
        if (el && !el._qpHidden && !insideChatOrPlugin(el)) {
          var flat = (el.textContent || "").replace(/\s+/g, "");
          if (flat.length < 30) {
            el.style.display = "none";
            el._qpHidden = true;
            hid = true;
          }
        }
      }
      if (hid) anchorHidden = true;
    } catch (e) {
    }
  }
  function refreshBarContent() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) {
      injectBar();
      return;
    }
    var sid = getSessionId();
    var activeSt = getActiveStream(sid);
    if (activeSt) {
      bar.className = "running";
      bar.innerHTML = !activeSt.tFirst && !activeSt.attached ? buildWaitingHtml() : buildRunningHtml(runningView(activeSt));
    } else {
      if (store.states[sid] && store.states[sid].suspended) {
        bar.className = "running";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>\u6B63\u5728\u91CD\u65B0\u63A5\u5165\u540E\u53F0\u751F\u6210\u2026</span>';
        positionBar();
        return;
      }
      var r = loadLastResult(sid);
      if (r) {
        bar.className = r.status === DONE ? "done" : r.status;
        bar.innerHTML = buildResultHtml(r);
      } else {
        bar.className = "";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>\u6682\u65E0\u6570\u636E\uFF0C\u53D1\u4E00\u6761\u6D88\u606F\u8BD5\u8BD5</span>';
      }
    }
    positionBar();
  }
  function injectBar() {
    if (document.getElementById(BAR_ID)) return true;
    var bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.title = "\u70B9\u51FB\u67E5\u770B\u672C\u8F6E\u901F\u5EA6\u3001\u7528\u91CF\u548C\u8017\u65F6";
    bar.setAttribute("role", "button");
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-label", "\u67E5\u770B\u672C\u8F6E\u751F\u6210\u8BE6\u60C5");
    bar.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onBarClick(e);
      }
    });
    bar.addEventListener("click", onBarClick);
    document.body.appendChild(bar);
    refreshBarContent();
    hideAnchor();
    return true;
  }
  function installRouteTracking() {
    if (!window.history) return;
    var visibleSid = getSessionId();
    function changed() {
      var sid = getSessionId();
      if (sid === visibleSid) return;
      visibleSid = sid;
      closeDetail();
      resetAnchorScan();
      refreshBarContent();
    }
    ["pushState", "replaceState"].forEach(function(name) {
      var original = window.history[name];
      if (typeof original !== "function") return;
      window.history[name] = function() {
        var result = original.apply(this, arguments);
        try {
          changed();
        } catch (eRoute) {
        }
        return result;
      };
    });
    window.addEventListener("popstate", changed);
  }
  renderer.refreshBarContent = refreshBarContent;

  // src/init.js
  function maintainStream(st, t) {
    if (st.active && !(st.attached && !st.replayDone) && (st.toolPending || st.toolResumeAt)) {
      if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st, { speed: 0 }));
      return;
    }
    if (!st.active || st.attached && !st.replayDone || st.toolPending || !st.tLast || t - st.tLast <= 2e3) return;
    closeCurrentSeg(st);
    st.pauseMs += Math.max(0, t - Math.max(st.tLast, st.idleAccountedUntil || 0));
    st.idleAccountedUntil = t;
    st.lastSpeed = 0;
    st.window = [];
    st.evWin = [];
    if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st, { speed: 0 }));
  }
  function init() {
    try {
      injectStyles();
    } catch (e) {
    }
    try {
      injectBar();
    } catch (e) {
    }
    try {
      installRouteTracking();
    } catch (e) {
    }
    try {
      refreshActiveLlm(false);
    } catch (e) {
    }
    try {
      window.addEventListener("resize", function() {
        try {
          positionBar();
        } catch (e) {
        }
      });
    } catch (e) {
    }
    var lastSession = getSessionId();
    var slowTick = 0;
    setInterval(function() {
      try {
        slowTick++;
        var curSession = getSessionId();
        Object.keys(store.states).forEach(function(sid) {
          var st = store.states[sid];
          if (!st || !st.active) return;
          if (st.pendingError && st.lastEventAt && now() - st.lastEventAt > 1600) {
            finishAbnormal(st, st.pendingError, "error_frame");
            return;
          }
          maintainStream(st, now());
        });
        if (curSession !== lastSession) {
          lastSession = curSession;
          resetAnchorScan();
          renderer.refreshBarContent();
          return;
        }
        positionBar();
        if (!document.getElementById(BAR_ID)) injectBar();
        if (slowTick % 3 === 0) hideAnchor(slowTick % 30 === 0);
      } catch (eLoop) {
      }
    }, 1e3);
    try {
      var observer = new MutationObserver(function() {
        if (!document.getElementById(BAR_ID)) injectBar();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() {
        observer.disconnect();
      }, 2e4);
    } catch (eObs) {
    }
  }

  // src/index.js
  (function() {
    "use strict";
    if (window.__qpTokenSpeedLoaded) return;
    window.__qpTokenSpeedLoaded = true;
    window.__qpTokenSpeedVersion = "2.0.0";
    if (typeof window !== "undefined") patchFetch();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();
})();

  // ════════════════════════════════════════════════════════════
  // 06-pricing.js · PRICING 价目表静态数据区 + 套餐额度/人民币/区间计算
  // ════════════════════════════════════════════════════════════
  // ---------- 套餐渠道（Agent Plan）抵扣 ----------
  // 依据官方计费规格文档：
  // 额度 = (输入token×系数 + 输出token×系数) / 10000（2026-09-01 起入=出系数）
  // 官方对拍示例：seed-2.1-turbo 50k入/0.5k出 → (50000×2.5+500×2.5)/10000 = 12.625
  // v1.8.0：这张表只在渠道=plan 时才查（同名模型在别家在卖别的计费方式）
  // v1.19.0：渠道代号 afp 更名 plan；旧历史数据与覆盖层旧键名均兼容
  // ════════════════════════════════════════════════════════════════════
  // 价目表 · 计费静态数据（v1.13.2 从逻辑里摘出，统一结构）——调价只改这一块
  //
  // 结构约定：所有"按模型名匹配"的表统一为 { keys:[小写模型名子串], ... }，命中即用。
  //   PRICING.plan.base            套餐渠道（Agent Plan）基础系数（数组顺序 = 匹配优先级！）
  //   PRICING.plan.promo           限时活动系数（UTC 毫秒窗口，过期自动失效回退基础表；exact:true 全字匹配）
  //   PRICING.deepseek.models     DeepSeek 官方价表（元/百万 token：offPeak/peak × cacheHit/input/output）
  //   PRICING.deepseek.peakHours  高峰时段（本地时间闭开区间，周末全天低谷）
  //   PRICING.alias               路由别名（控制台 Auto）：keys + 悬浮提示文案
  //   PRICING.generic.models      泛渠道价表（v1.18.0 建 / v1.19.0 全字段）：{ channel, keys, exact?,
  //                               table? | coef?, start?, end?, unit?, label? }——任意渠道配条目即算钱，
  //                               UI 自动显示"费用/套餐抵扣"。table=按量（元/百万，peak/peakHours/
  //                               weekendOffPeak/cacheHit 可选），coef=套餐（额度=(入+出)×系数/10000），
  //                               start/end（UTC 毫秒）可选窗口（窗口外跳过回退下一条），unit 默认 cny
  //   PRICING.customChannels      自定义渠道映射（v1.18.0）：{ keys:[provider_id/base_url 子串], channel:"渠道名" }
  // 运行时覆盖层（v1.18.0 建 / v1.19.0 扩展）：localStorage["qp_token_speed_pricing"] 放一份 JSON 即可加模型/调价/接渠道，
  //   不用改源码重建；用户条目合并进对应表且排在最前（优先命中），解析/结构异常整份忽略并 console.warn，
  //   内置表原样生效。
  // 数据来源：官方计费规格文档（对拍示例：seed-2.1-turbo 50k入/0.5k出 → 12.625 额度）
  //          + 官方核对文档 2026-09-16 + DeepSeek 2026-09-10 调价
  // 原则：没对拍过/官方没公布的，宁可不加（面板显示"系数未知/无价表"），不猜数。
  // ════════════════════════════════════════════════════════════════════
  var PRICING = {
    // —— 套餐渠道（Agent Plan）：额度 = (输入tok×系数 + 输出tok×系数) / 10000（2026-09-01 起入=出同系数）
    // v1.19.0：代号 afp → plan；覆盖层旧键 u.afp 仍兼容
    plan: {
      // 基础系数表；数组顺序即匹配优先级：glm-5.3-flash(0.5) 必须排在 glm-5.3(4.5) 前（差 9 倍）
      // v1.8.0：这张表只在渠道=plan 时才查（同名模型在别家在卖别的计费方式）
      base: [
        { keys: ["seed-2.0-mini"], coef: 0.25 },
        { keys: ["seed-2.0-lite", "deepseek-v4-flash", "deepseek-v4.1-flash", "glm-5.3-flash", "embedding-vision"], coef: 0.5 },
        { keys: ["seed-2.1-turbo", "seed-evolving", "minimax-m3"], coef: 2.5 },
        { keys: ["kimi-k2.7", "glm-5.2", "glm-5.3", "glm-latest"], coef: 4.5 },
        { keys: ["deepseek-v4-pro"], coef: 5.5 },
        { keys: ["kimi-k3"], coef: 10 }
      ],
      // 限时活动：窗口内优先于基础表；活动结束后官方系数未定 → 不入基础表（届时显示"系数未知"，不猜）
      // 边界为 UTC（北京 -8h）：
      //   deepseek-v4.1-flash 五折 9/15 00:00–9/28 24:00 北京 → 2026-09-14T16:00 ~ 2026-09-28T16:00 UTC
      //   Auto 0.5            6/10 18:00–11/8 23:59 北京 → 2026-06-10T10:00 ~ 2026-11-08T16:00 UTC
      // exact:true = 全字匹配（否则 "auto" 子串可能误伤别的名字）
      promo: [
        { keys: ["deepseek-v4.1-flash"], coef: 0.25, start: Date.UTC(2026, 8, 14, 16, 0, 0), end: Date.UTC(2026, 8, 28, 16, 0, 0), label: "限时五折（9/15–9/28）" },
        { keys: ["auto"], exact: true, coef: 0.5, start: Date.UTC(2026, 5, 10, 10, 0, 0), end: Date.UTC(2026, 10, 8, 16, 0, 0), label: "Auto 活动价（6/10–11/8）" }
      ]
    },
    // —— DeepSeek 官方按量（人民币）。只有对拍过的模型才入表，其余不显示金额（不猜）
    // 注意：若你在其他脚本里拷贝过这份时段规则，调价/调时段时记得几处同步
    deepseek: {
      models: [
        { keys: ["flash"], table: { offPeak: { cacheHit: 0.02, input: 1, output: 4 }, peak: { cacheHit: 0.04, input: 2, output: 8 } } }
      ],
      // 高峰时段（本地时间，24h 制，闭开区间）：工作日 9-12 / 14-18 / 20-23，周末全天低谷
      peakHours: [[9, 12], [14, 18], [20, 23]],
      weekendOffPeak: true
    },
    // —— 路由别名（ark-code-latest = 控制台 Auto，手册方式 B，用户 2026-09-16 确认）
    alias: {
      keys: ["ark-code-latest", "ark-latest"],
      tip: "ark-code-latest 是控制台的路由别名，实际走 Auto 模式：真实模型由控制台自动调度，"
        + "请求和用量里只带这个别名。Auto 在活动期（2026-06-10～11-08）固定按系数 0.5 抵扣，"
        + "与底层路由到哪个模型无关；活动结束后官方系数未定，届时插件会只给参考区间。"
        + "想要始终精确显示，把模型名写成具体的（如 glm-5.3 / deepseek-v4-flash），别用别名"
    },
    // —— 泛渠道价表（v1.18.0 建 / v1.19.0 全字段）：第三方渠道配了 table 或 coef 就算钱（覆盖层可整体注入）
    generic: { models: [] },
    // —— 自定义渠道映射（v1.18.0）：resolveChannel 在内置判定后、other 前查这张表
    customChannels: []
  };
  // v1.18.0 · 运行时覆盖层（v1.19.0 扩展）：localStorage["qp_token_speed_pricing"] 放一份 JSON 即可
  // 加模型/调价/接渠道，不用改源码重建。用户条目合并进对应表并排在最前（优先命中）；JSON 解析失败/
  // 结构不对 → 整份忽略并 console.warn，内置表原样生效，绝不因此崩面板。支持字段：
  //   plan.base / plan.promo（旧键名 afp.* 仍兼容）/ deepseek.models（数组，前置合并）、
  //   deepseek.peakHours（替换）、deepseek.weekendOffPeak（替换）、alias.keys（前置合并）、
  //   generic.models / customChannels（整体提供）
  (function applyPricingOverlay() {
    var raw = null;
    try { raw = localStorage.getItem("qp_token_speed_pricing"); } catch (e) { return; }
    if (!raw) return;
    var u = null;
    try { u = JSON.parse(raw); } catch (e) { console.warn("[token-speed] pricing 覆盖层不是合法 JSON，已忽略"); return; }
    if (!u || typeof u !== "object") return;
    function entryArr(a) {
      if (Object.prototype.toString.call(a) !== "[object Array]") return false;
      for (var i = 0; i < a.length; i++) {
        if (!a[i] || typeof a[i] !== "object" || Object.prototype.toString.call(a[i].keys) !== "[object Array]") return false;
      }
      return true;
    }
    // promo 额外要求 start/end/coef 为数字（缺窗口的活动条目会永久生效，必须拦下）
    function promoArr(a) {
      if (!entryArr(a)) return false;
      for (var i = 0; i < a.length; i++) {
        if (typeof a[i].start !== "number" || typeof a[i].end !== "number" || typeof a[i].coef !== "number") return false;
      }
      return true;
    }
    try {
      if (u.plan && entryArr(u.plan.base)) PRICING.plan.base = u.plan.base.concat(PRICING.plan.base);
      if (u.plan && promoArr(u.plan.promo)) PRICING.plan.promo = u.plan.promo.concat(PRICING.plan.promo);
      if (u.afp && entryArr(u.afp.base)) PRICING.plan.base = u.afp.base.concat(PRICING.plan.base); // v1.19.0 前旧键名兼容
      if (u.afp && promoArr(u.afp.promo)) PRICING.plan.promo = u.afp.promo.concat(PRICING.plan.promo);
      if (u.deepseek && entryArr(u.deepseek.models)) PRICING.deepseek.models = u.deepseek.models.concat(PRICING.deepseek.models);
      if (u.deepseek && Object.prototype.toString.call(u.deepseek.peakHours) === "[object Array]") PRICING.deepseek.peakHours = u.deepseek.peakHours;
      if (u.deepseek && typeof u.deepseek.weekendOffPeak === "boolean") PRICING.deepseek.weekendOffPeak = u.deepseek.weekendOffPeak;
      if (u.alias && entryArr(u.alias.keys)) PRICING.alias.keys = u.alias.keys.concat(PRICING.alias.keys);
      if (u.generic && entryArr(u.generic.models)) PRICING.generic.models = u.generic.models;
      if (entryArr(u.customChannels)) PRICING.customChannels = u.customChannels;
    } catch (e) { console.warn("[token-speed] pricing 覆盖层应用失败，使用内置价目", e); }
  })();

  // 自定义渠道映射：PRICING.customChannels = [{ keys:[provider_id/base_url 子串], channel:"渠道名" }]
  // （05-channel.js 的 resolveChannel 在内置判定之后、other 之前调用；没配置/没命中 → 空串照旧）
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
        if (PRICING.plan.promo[p].exact ? (m === kp) : (m.indexOf(kp) >= 0)) return PRICING.plan.promo[p].coef;
      }
    }
    for (var i = 0; i < PRICING.plan.base.length; i++) {
      for (var j = 0; j < PRICING.plan.base[i].keys.length; j++) {
        if (m.indexOf(PRICING.plan.base[i].keys[j]) >= 0) return PRICING.plan.base[i].coef;
      }
    }
    return null;
  }
  // 路由别名：文案在 PRICING.alias.tip（这里只留引用，UI 多处在用）
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
  // Auto 活动期系数（取 PRICING.plan.promo 里 exact 的 auto 条目；活动期=0.5，期外=null）
  function autoPromoCoef() {
    var t = Date.now();
    for (var p = 0; p < PRICING.plan.promo.length; p++) {
      if (PRICING.plan.promo[p].exact && PRICING.plan.promo[p].keys.indexOf("auto") >= 0
        && t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) return PRICING.plan.promo[p].coef;
    }
    return null;
  }
  // 系数表的实际下限/上限（随表自动取，不写死漂移）：含基础表与当前生效的活动
  function planCoefBounds() {
    var lo = null, hi = null, t = Date.now();
    function bump(c) { if (c == null) return; if (lo == null || c < lo) lo = c; if (hi == null || c > hi) hi = c; }
    for (var i = 0; i < PRICING.plan.base.length; i++) bump(PRICING.plan.base[i].coef);
    for (var p = 0; p < PRICING.plan.promo.length; p++) {
      if (t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) bump(PRICING.plan.promo[p].coef);
    }
    return { lo: lo == null ? 0.25 : lo, hi: hi == null ? 10 : hi };
  }
  // 只有套餐渠道才有额度；渠道不对 → null（旧版这里只看模型名）
  // v1.19.0：旧历史数据的渠道名 "afp" 读取时自动归一为 "plan"
  function calcPlan(channel, model, promptTok, completionTok) {
    if (channel === "afp") channel = "plan";
    if (channel !== "plan") return null;
    // 路由别名 = Auto：活动期固定 0.5（官方明示，精确算）；期外无固定值 → 走区间
    if (isAliasModel(model)) {
      var ac = autoPromoCoef();
      if (ac == null) return null;
      return ((promptTok || 0) * ac + (completionTok || 0) * ac) / 10000;
    }
    var c = planCoef(model);
    if (!c) return null;
    return ((promptTok || 0) * c + (completionTok || 0) * c) / 10000;
  }
  // 路由别名在 Auto 活动期结束后：系数未定，只给 [下限, 上限] 参考区间（不假装精确）
  // v1.19.0：旧历史数据渠道名 "afp" 一并认
  function calcPlanRange(channel, model, promptTok, completionTok) {
    if ((channel !== "plan" && channel !== "afp") || !isAliasModel(model)) return null;
    if (autoPromoCoef() != null) return null; // 活动期有精确值，不需要区间
    var b = planCoefBounds(), n = ((promptTok || 0) + (completionTok || 0));
    return { lo: n * b.lo / 10000, hi: n * b.hi / 10000, coefLo: b.lo, coefHi: b.hi };
  }
  function fmtPlanRange(r) {
    if (!r) return "";
    return fmtPlan(r.lo) + "~" + fmtPlan(r.hi);
  }

  // DeepSeek 官方价格（元/百万 token），2026-09-10 调价后
  // 注意：若你在其他脚本里拷贝过这份高峰时段规则（工作日 9-12/14-18/20-23），调价/调时段时记得几处同步
  // 价表本体在 PRICING.deepseek.models（价目表统一摘在那里）；这里只留匹配与时段逻辑
  function priceTableFor(model) {
    var m = String(model || "").toLowerCase();
    for (var i = 0; i < PRICING.deepseek.models.length; i++) {
      for (var j = 0; j < PRICING.deepseek.models[i].keys.length; j++) {
        if (m.indexOf(PRICING.deepseek.models[i].keys[j]) >= 0) return PRICING.deepseek.models[i].table;
      }
    }
    return null;
  }
  // 高峰判定（v1.18.0 泛化）：传了带 peakHours 的表就按表的时段；否则用 DeepSeek 全局规则。
  // 带 peak 价的表必须同时带 peakHours，否则会落到 DeepSeek 时段（结构约定见文件头）。
  function isPeakHour(t) {
    var n = new Date();
    var h = n.getHours(), wd = n.getDay(); // 0=周日
    var ph = (t && t.peakHours) ? t.peakHours : PRICING.deepseek.peakHours;
    var weekendOff = (t && typeof t.weekendOffPeak === "boolean") ? t.weekendOffPeak : PRICING.deepseek.weekendOffPeak;
    if (weekendOff && (wd === 0 || wd === 6)) return false;
    for (var i = 0; i < ph.length; i++) {
      if (h >= ph[i][0] && h < ph[i][1]) return true;
    }
    return false;
  }
  // 泛渠道条目匹配（v1.19.0 泛化）：条目须显式带 channel；keys 子串/exact 命中即用（条目顺序 = 优先级）。
  // start/end（UTC 毫秒）可选：限时条目窗口外自动跳过，回退后续条目。
  function genericEntryFor(channel, model) {
    var g = (PRICING.generic && PRICING.generic.models) || [];
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
        if (it.exact ? (m === String(ks[j]).toLowerCase()) : (m.indexOf(String(ks[j]).toLowerCase()) >= 0)) return it;
      }
    }
    return null;
  }
  // 计价（v1.18.0 泛化 / v1.19.0 补完）：deepseek 渠道用官方价表；其他渠道查 PRICING.generic.models
  // ——条目带 coef → 套餐模式（额度=(入+出)×系数/10000，与 plan 渠道同口径）；带 table → 按量模式
  // （元/百万；cacheHit/peak 可选：缺 cacheHit 按输入价计缓存部分，缺 peak 恒低谷）。没配条目 → null，不猜。
  function calcCost(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan"; // 旧历史数据渠道名兼容
    if (!ch || ch === "plan") return null; // 套餐渠道的额度走 calcPlan，不在这里
    var pt = promptTok || 0, ct = completionTok || 0;
    var t = (ch === "deepseek") ? priceTableFor(model) : (genericEntryFor(ch, model) || {}).table;
    if (t && t.offPeak && t.offPeak.input != null && t.offPeak.output != null) {
      var p = (t.peak && isPeakHour(t)) ? t.peak : t.offPeak;
      var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
      var inPrice = (p.cacheHit != null) ? p.cacheHit : p.input;
      return (hit / 1e6) * inPrice + (Math.max(0, pt - hit) / 1e6) * p.input + (ct / 1e6) * p.output;
    }
    // v1.19.0：套餐模式条目（coef）——任意自定义渠道可按套餐额度计费
    var e = genericEntryFor(ch, model);
    if (e && e.coef != null) return ((pt + ct) * e.coef) / 10000;
    return null;
  }
  // 该渠道金额的显示单位（v1.19.0）：plan=套餐额度 / cny=人民币；旧数据无此字段按 cny 显示，零迁移
  function costUnitFor(channel, model) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan";
    if (!ch || ch === "plan") return "";
    if (ch === "deepseek") return "cny";
    var e = genericEntryFor(ch, model);
    return (e && e.coef != null) ? "plan" : "cny";
  }

  // 渠道是否配置过价表（决定"无价表"提示是否出现；v1.18.0 泛化：泛渠道表也算数；v1.19.0 计入 coef 条目）
  function channelHasPriceTable(ch) {
    var c = String(ch || "").toLowerCase();
    if (c === "afp") c = "plan";
    if (!c) return false;
    if (c === "deepseek") return true;
    if (c === "plan") return false; // 套餐渠道走 coefMissing 提示，不算"无价表"
    var g = (PRICING.generic && PRICING.generic.models) || [];
    for (var i = 0; i < g.length; i++) {
      if (g[i] && String(g[i].channel || "").toLowerCase() === c && (g[i].table || g[i].coef != null)) return true;
    }
    return false;
  }

  // 金额相关字段（bar/面板/实时快照共用一份口径，避免三处漂移）
  // v1.19.0：channel 入参先归一（旧历史数据 "afp" → "plan"）再查价；新增 costUnit 供 UI 选单位
  function moneyFields(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = channel || "";
    var chN = (ch === "afp") ? "plan" : ch;
    var cost = calcCost(chN, model, promptTok, completionTok, cacheHitTok);
    var afp = calcPlan(chN, model, promptTok, completionTok);
    var alias = isAliasModel(model);
    var afpRange = calcPlanRange(chN, model, promptTok, completionTok);
    return {
      channel: ch,
      afp: afp,
      cost: cost,
      costUnit: costUnitFor(chN, model),
      aliasModel: alias,
      afpLo: afpRange ? afpRange.lo : null,
      afpHi: afpRange ? afpRange.hi : null,
      // 路由别名：算不出具体值（别名为真且无精确系数）→ 用区间，不再笼统报"系数未知"
      coefRange: !!afpRange,
      // 渠道=套餐但模型不在系数表且不是路由别名 → 面板提示"系数未知"
      coefMissing: chN === "plan" && afp == null && !afpRange,
      // 渠道配过价表但这模型算不出钱 → 面板提示"无价表"
      priceMissing: channelHasPriceTable(chN) && cost == null,
      provider: (activeLlm && activeLlm.providerId) || ""
    };
  }

  // ════════════════════════════════════════════════════════════
  // 06-pricing.js · PRICING 价目表静态数据区 + AFP/人民币/区间计算
  // ════════════════════════════════════════════════════════════
  // ---------- 方舟 Agent Plan（AFP）抵扣 ----------
  // 依据官方计费规格文档：
  // AFP = (输入token×系数 + 输出token×系数) / 10000（2026-09-01 起入=出系数）
  // 官方对拍示例：seed-2.1-turbo 50k入/0.5k出 → (50000×2.5+500×2.5)/10000 = 12.625
  // v1.8.0：这张表只在渠道=afp 时才查（同名模型在别家在卖别的计费方式）
  // ════════════════════════════════════════════════════════════════════
  // 价目表 · 计费静态数据（v1.13.2 从逻辑里摘出，统一结构）——调价只改这一块
  //
  // 结构约定：所有"按模型名匹配"的表统一为 { keys:[小写模型名子串], ... }，命中即用。
  //   PRICING.afp.base            方舟 Agent Plan 基础系数（数组顺序 = 匹配优先级！）
  //   PRICING.afp.promo           限时活动系数（UTC 毫秒窗口，过期自动失效回退基础表；exact:true 全字匹配）
  //   PRICING.deepseek.models     DeepSeek 官方价表（元/百万 token：offPeak/peak × cacheHit/input/output）
  //   PRICING.deepseek.peakHours  高峰时段（本地时间闭开区间，周末全天低谷）
  //   PRICING.alias               路由别名（控制台 Auto）：keys + 悬浮提示文案
  // 数据来源：官方计费规格文档（对拍示例：seed-2.1-turbo 50k入/0.5k出 → 12.625 AFP）
  //          + 官方核对文档 2026-09-16 + DeepSeek 2026-09-10 调价
  // 原则：没对拍过/官方没公布的，宁可不加（面板显示"系数未知/无价表"），不猜数。
  // ════════════════════════════════════════════════════════════════════
  var PRICING = {
    // —— 火山方舟 Agent Plan：AFP = (输入tok×系数 + 输出tok×系数) / 10000（2026-09-01 起入=出同系数）
    afp: {
      // 基础系数表；数组顺序即匹配优先级：glm-5.3-flash(0.5) 必须排在 glm-5.3(4.5) 前（差 9 倍）
      // v1.8.0：这张表只在渠道=afp 时才查（同名模型在别家在卖别的计费方式）
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
    // ⚠️ 孪生实现警告：deepseek-balance 插件 plugin.py 的 _is_peak_hour 与下面 peakHours
    //    是同一套规则的两份拷贝——DeepSeek 调价/调时段时必须两处同步改
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
      tip: "ark-code-latest 是火山方舟的路由别名，实际走 Auto 模式：真实模型由控制台自动调度，"
        + "请求和用量里只带这个别名。Auto 在活动期（2026-06-10～11-08）固定按系数 0.5 抵扣，"
        + "与底层路由到哪个模型无关；活动结束后官方系数未定，届时插件会只给参考区间。"
        + "想要始终精确显示，把模型名写成具体的（如 glm-5.3 / deepseek-v4-flash），别用别名"
    }
  };
  function afpCoef(model) {
    if (!model) return null;
    var m = String(model).toLowerCase();
    var t = Date.now();
    for (var p = 0; p < PRICING.afp.promo.length; p++) {
      if (t < PRICING.afp.promo[p].start || t >= PRICING.afp.promo[p].end) continue;
      for (var pk = 0; pk < PRICING.afp.promo[p].keys.length; pk++) {
        var kp = PRICING.afp.promo[p].keys[pk];
        if (PRICING.afp.promo[p].exact ? (m === kp) : (m.indexOf(kp) >= 0)) return PRICING.afp.promo[p].coef;
      }
    }
    for (var i = 0; i < PRICING.afp.base.length; i++) {
      for (var j = 0; j < PRICING.afp.base[i].keys.length; j++) {
        if (m.indexOf(PRICING.afp.base[i].keys[j]) >= 0) return PRICING.afp.base[i].coef;
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
  // Auto 活动期系数（取 PRICING.afp.promo 里 exact 的 auto 条目；活动期=0.5，期外=null）
  function autoPromoCoef() {
    var t = Date.now();
    for (var p = 0; p < PRICING.afp.promo.length; p++) {
      if (PRICING.afp.promo[p].exact && PRICING.afp.promo[p].keys.indexOf("auto") >= 0
        && t >= PRICING.afp.promo[p].start && t < PRICING.afp.promo[p].end) return PRICING.afp.promo[p].coef;
    }
    return null;
  }
  // 系数表的实际下限/上限（随表自动取，不写死漂移）：含基础表与当前生效的活动
  function afpCoefBounds() {
    var lo = null, hi = null, t = Date.now();
    function bump(c) { if (c == null) return; if (lo == null || c < lo) lo = c; if (hi == null || c > hi) hi = c; }
    for (var i = 0; i < PRICING.afp.base.length; i++) bump(PRICING.afp.base[i].coef);
    for (var p = 0; p < PRICING.afp.promo.length; p++) {
      if (t >= PRICING.afp.promo[p].start && t < PRICING.afp.promo[p].end) bump(PRICING.afp.promo[p].coef);
    }
    return { lo: lo == null ? 0.25 : lo, hi: hi == null ? 10 : hi };
  }
  // 只有渠道=方舟套餐时才有 AFP；渠道不对 → null（旧版这里只看模型名）
  function calcAFP(channel, model, promptTok, completionTok) {
    if (channel !== "afp") return null;
    // 路由别名 = Auto：活动期固定 0.5（官方明示，精确算）；期外无固定值 → 走区间
    if (isAliasModel(model)) {
      var ac = autoPromoCoef();
      if (ac == null) return null;
      return ((promptTok || 0) * ac + (completionTok || 0) * ac) / 10000;
    }
    var c = afpCoef(model);
    if (!c) return null;
    return ((promptTok || 0) * c + (completionTok || 0) * c) / 10000;
  }
  // 路由别名在 Auto 活动期结束后：系数未定，只给 [下限, 上限] 参考区间（不假装精确）
  function calcAFPRange(channel, model, promptTok, completionTok) {
    if (channel !== "afp" || !isAliasModel(model)) return null;
    if (autoPromoCoef() != null) return null; // 活动期有精确值，不需要区间
    var b = afpCoefBounds(), n = ((promptTok || 0) + (completionTok || 0));
    return { lo: n * b.lo / 10000, hi: n * b.hi / 10000, coefLo: b.lo, coefHi: b.hi };
  }
  function fmtAFPRange(r) {
    if (!r) return "";
    return fmtAFP(r.lo) + "~" + fmtAFP(r.hi);
  }

  // DeepSeek 官方价格（元/百万 token），2026-09-10 调价后
  // ⚠️ 孪生实现警告：deepseek-balance 插件 plugin.py 的 _is_peak_hour 与这里的
  // 高峰时段规则（工作日 9-12/14-18/20-23）是同一套规则的两份拷贝——DeepSeek
  // 调价时必须两处同步改
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
  function isPeakHour() {
    var n = new Date();
    var h = n.getHours(), wd = n.getDay(); // 0=周日
    if (PRICING.deepseek.weekendOffPeak && (wd === 0 || wd === 6)) return false;
    for (var i = 0; i < PRICING.deepseek.peakHours.length; i++) {
      if (h >= PRICING.deepseek.peakHours[i][0] && h < PRICING.deepseek.peakHours[i][1]) return true;
    }
    return false;
  }
  // 只有渠道=DeepSeek 官方 且 有该模型价表时才计人民币
  function calcCost(channel, model, promptTok, completionTok, cacheHitTok) {
    if (channel !== "deepseek") return null;
    var t = priceTableFor(model);
    if (!t) return null;
    var p = isPeakHour() ? t.peak : t.offPeak;
    var pt = promptTok || 0, ct = completionTok || 0;
    var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
    var miss = Math.max(0, pt - hit);
    return (hit / 1e6) * p.cacheHit + (miss / 1e6) * p.input + (ct / 1e6) * p.output;
  }

  // 金额相关字段（bar/面板/实时快照共用一份口径，避免三处漂移）
  function moneyFields(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = channel || "";
    var cost = calcCost(ch, model, promptTok, completionTok, cacheHitTok);
    var afp = calcAFP(ch, model, promptTok, completionTok);
    var alias = isAliasModel(model);
    var afpRange = calcAFPRange(ch, model, promptTok, completionTok);
    return {
      channel: ch,
      afp: afp,
      cost: cost,
      aliasModel: alias,
      afpLo: afpRange ? afpRange.lo : null,
      afpHi: afpRange ? afpRange.hi : null,
      // 路由别名：算不出具体值（别名为真且无精确系数）→ 用区间，不再笼统报"系数未知"
      coefRange: !!afpRange,
      // 渠道=方舟套餐但模型不在系数表且不是路由别名 → 面板提示"系数未知"
      coefMissing: ch === "afp" && afp == null && !afpRange,
      // 渠道=DeepSeek 官方但没这模型的价表 → 面板提示"无价表"
      priceMissing: ch === "deepseek" && cost == null,
      provider: (activeLlm && activeLlm.providerId) || ""
    };
  }

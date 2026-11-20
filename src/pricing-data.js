// ════════════════════════════════════════════════════════════════════
// 价目表 · 计费静态数据（纯数据，与计价引擎 pricing.js 分离）——调价只改这一块
//
// 结构约定：所有"按模型名匹配"的表统一为 { keys:[小写模型名子串], ... }，命中即用。
//   PRICING.plan.base            套餐渠道（Agent Plan）基础系数（数组顺序 = 匹配优先级！）
//   PRICING.plan.promo           限时活动系数（UTC 毫秒窗口，过期自动失效回退基础表；exact:true 全字匹配）
//   PRICING.deepseek.models      DeepSeek 官方价表（元/百万 token：offPeak/peak × cacheHit/input/output）
//   PRICING.deepseek.peakHours   高峰时段（本地时间闭开区间，周末全天低谷）
//   PRICING.alias                路由别名（控制台 Auto）：keys + 悬浮提示文案
//   PRICING.generic.models       泛渠道价表：{ channel, keys, exact?, table? | coef?, start?, end?, unit?, label? }
//   PRICING.customChannels       自定义渠道映射：{ keys:[provider_id/base_url 子串], channel:"渠道名" }
//   PRICING.tokenplan.models     阿里云百炼 Token Plan（credits 计价，见下方专节）
// 运行时覆盖层：localStorage["qp_token_speed_pricing"] 放一份 JSON 即可加模型/调价/接渠道，
//   不用改源码重建；用户条目合并进对应表且排在最前（优先命中），解析/结构异常整份忽略并 console.warn。
// 数据来源：官方计费规格文档（对拍示例：seed-2.1-turbo 50k入/0.5k出 → 12.625 额度）
//          + 官方核对文档 2026-09-16 + DeepSeek 2026-09-10 调价
//          + 百炼 Token Plan 用量与额度页官方对拍示例 + 百炼模型价格页刊例价（2026-11-20 核对）
// 原则：没对拍过/官方没公布的，宁可不加（面板显示"系数未知/无价表"），不猜数。
// ════════════════════════════════════════════════════════════════════
export const PRICING = {
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
      { keys: ["deepseek-v4.1-flash"], coef: 0.25, start: Date.UTC(2026, 8, 14, 16, 0, 0), end: Date.UTC(2026, 8, 28, 16, 0, 0), label: "限时五折（9/15–9/28）" },
      { keys: ["auto"], exact: true, coef: 0.5, start: Date.UTC(2026, 5, 10, 10, 0, 0), end: Date.UTC(2026, 10, 8, 16, 0, 0), label: "Auto 活动价（6/10–11/8）" }
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
    tip: "ark-code-latest 是控制台的路由别名，实际走 Auto 模式：真实模型由控制台自动调度，"
      + "请求和用量里只带这个别名。Auto 在活动期（2026-06-10～11-08）固定按系数 0.5 抵扣，"
      + "与底层路由到哪个模型无关；活动结束后官方系数未定，届时插件会只给参考区间。"
      + "想要始终精确显示，把模型名写成具体的（如 glm-5.3 / deepseek-v4-flash），别用别名"
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
      { keys: ["qwen4-max-preview", "qwen4.0-max-preview"], assumedBase: true,
        tiers: [{ upTo: Infinity, input: 10, output: 30, cacheHit: 0.5 }],
        preview: { start: Date.UTC(2026, 10, 11, 2, 0, 0), end: Date.UTC(2026, 10, 25, 16, 0, 0), factor: 0.2 }, night: 0.4 },
      { keys: ["qwen4-max"], tiers: [{ upTo: Infinity, input: 10, output: 30, cacheHit: 0.5 }] },
      { keys: ["qwen3.8-max"], tiers: [{ upTo: Infinity, input: 12, output: 36, cacheHit: 1.5 }], night: 0.4 },
      { keys: ["qwen3.8-flash"], tiers: [{ upTo: Infinity, input: 0.8, output: 2.7 }], night: 0.4 },
      { keys: ["qwen3.7-max"], tiers: [{ upTo: Infinity, input: 12, output: 36 }] },
      { keys: ["qwen3.7-plus"], tiers: [{ upTo: 256000, input: 2, output: 8 }, { upTo: Infinity, input: 6, output: 24 }] },
      { keys: ["qwen3.6-plus"], tiers: [{ upTo: 256000, input: 2, output: 12, cacheHit: 0.2 }, { upTo: Infinity, input: 8, output: 48 }] },
      { keys: ["qwen3.6-flash"], tiers: [{ upTo: 256000, input: 1.2, output: 7.2 }, { upTo: Infinity, input: 4.8, output: 28.8 }] },
      { keys: ["deepseek-v4.1-flash"], tiers: [{ upTo: Infinity, input: 2, output: 8 }], night: 0.5, bailianPeak: true },
      { keys: ["deepseek-v4-pro-0813"], tiers: [{ upTo: Infinity, input: 9, output: 27 }], night: 0.5, bailianPeak: true },
      { keys: ["deepseek-v4-flash-0731"], tiers: [{ upTo: Infinity, input: 3, output: 9 }], night: 0.5, bailianPeak: true },
      { keys: ["deepseek-v4-pro"], tiers: [{ upTo: Infinity, input: 12, output: 24 }] },
      { keys: ["glm-5.3"], tiers: [{ upTo: Infinity, input: 8, output: 28 }] },
      { keys: ["glm-5.2"], tiers: [{ upTo: Infinity, input: 8, output: 28 }] },
      { keys: ["glm-5.1"], tiers: [{ upTo: 32000, input: 6, output: 24 }, { upTo: Infinity, input: 8, output: 28 }] },
      { keys: ["glm-5"], tiers: [{ upTo: 32000, input: 4, output: 18 }, { upTo: Infinity, input: 6, output: 22 }] },
      { keys: ["kimi-k2.7-code"], tiers: [{ upTo: Infinity, input: 6.5, output: 27 }] },
      { keys: ["kimi-k2.6"], tiers: [{ upTo: Infinity, input: 6.5, output: 27, cacheHit: 1.1 }] },
      { keys: ["kimi-k2.5"], tiers: [{ upTo: Infinity, input: 4, output: 21 }] },
      { keys: ["minimax-m2.5"], tiers: [{ upTo: Infinity, input: 2.1, output: 8.4, cacheHit: 0.21 }] }
    ],
    // 官方夜间折扣窗口：北京时间 22:00–次日 08:00（用 UTC+8 换算，与用户本机时区无关）
    nightWindow: [22, 8]
  }
};
// Token Plan 个人版套餐档位（官方 2026-11-16 页：Pro 降价至 312 元/月、额度上调）
// 用于面板"套餐摊销"：credits × (月费/月额度) = 按订阅实际付出的人民币成本
export const TP_PLANS = [
  { id: "lite", name: "Lite", price: 39, quota: 20000 },
  { id: "essential", name: "Essential", price: 79, quota: 45000 },
  { id: "standard", name: "Standard", price: 139, quota: 80000 },
  { id: "pro", name: "Pro", price: 312, quota: 200000 }
];

// 运行时覆盖层：localStorage["qp_token_speed_pricing"] 放一份 JSON 即可加模型/调价/接渠道。
// 用户条目合并进对应表并排在最前（优先命中）；JSON 解析失败/结构不对 → 整份忽略并 console.warn，
// 内置表原样生效，绝不因此崩面板。旧键名 afp.* 仍兼容。
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
  // tokenplan 条目必须带 tiers 数组且每档 input/output 为数字（防坏覆盖层把计价算崩）
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
  } catch (e) { console.warn("[token-speed] pricing 覆盖层应用失败，使用内置价目", e); }
})();
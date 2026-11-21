// 计价引擎（原 06-pricing 逻辑部分）：套餐额度 / 人民币 / Credits / 区间计算。
// 价表数据在 pricing-data.js（纯数据），本文件只做匹配与计算。
import { PRICING } from "./pricing-data.js";
import { fmtPlan } from "./utils.js";
import { store } from "./store.js";

// 自定义渠道映射：PRICING.customChannels = [{ keys:[provider_id/base_url 子串], channel:"渠道名" }]
// （channel.js 的 resolveChannel 在内置判定之后、other 之前调用；没配置/没命中 → 空串照旧）
export function customChannelOf(pid, bu) {
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

export function planCoef(model) {
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
// 路由别名：文案在 PRICING.alias.tip（这里只留引用，UI 多处在用）
export var ALIAS_TIP = PRICING.alias.tip;
export function modelBaseName(model) {
  return String(model || "").toLowerCase().replace(/\s*\[\s*1m\s*\]\s*$/g, "").trim();
}
export function isAliasModel(model) {
  var m = modelBaseName(model);
  for (var i = 0; i < PRICING.alias.keys.length; i++) {
    if (m.indexOf(PRICING.alias.keys[i]) >= 0) return true;
  }
  return false;
}
// Auto 活动期系数（取 PRICING.plan.promo 里 exact 的 auto 条目；活动期=0.5，期外=null）
export function autoPromoCoef() {
  var t = Date.now();
  for (var p = 0; p < PRICING.plan.promo.length; p++) {
    if (PRICING.plan.promo[p].exact && PRICING.plan.promo[p].keys.indexOf("auto") >= 0
      && t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) return PRICING.plan.promo[p].coef;
  }
  return null;
}
// 系数表的实际下限/上限（随表自动取，不写死漂移）：含基础表与当前生效的活动
export function planCoefBounds() {
  var lo = null, hi = null, t = Date.now();
  function bump(c) { if (c == null) return; if (lo == null || c < lo) lo = c; if (hi == null || c > hi) hi = c; }
  for (var i = 0; i < PRICING.plan.base.length; i++) bump(PRICING.plan.base[i].coef);
  for (var p = 0; p < PRICING.plan.promo.length; p++) {
    if (t >= PRICING.plan.promo[p].start && t < PRICING.plan.promo[p].end) bump(PRICING.plan.promo[p].coef);
  }
  return { lo: lo == null ? 0.25 : lo, hi: hi == null ? 10 : hi };
}
// 只有套餐渠道才有额度；渠道不对 → null（旧版这里只看模型名）。旧历史数据渠道名 "afp" 归一为 "plan"
export function calcPlan(channel, model, promptTok, completionTok) {
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
export function calcPlanRange(channel, model, promptTok, completionTok) {
  if ((channel !== "plan" && channel !== "afp") || !isAliasModel(model)) return null;
  if (autoPromoCoef() != null) return null; // 活动期有精确值，不需要区间
  var b = planCoefBounds(), n = (promptTok || 0) + (completionTok || 0);
  return { lo: n * b.lo / 10000, hi: n * b.hi / 10000, coefLo: b.lo, coefHi: b.hi };
}
export function fmtPlanRange(r) {
  if (!r) return "";
  return fmtPlan(r.lo) + "~" + fmtPlan(r.hi);
}

// DeepSeek 官方价格（元/百万 token）。价表本体在 PRICING.deepseek.models；这里只留匹配与时段逻辑
export function priceTableFor(model) {
  var m = String(model || "").toLowerCase();
  for (var i = 0; i < PRICING.deepseek.models.length; i++) {
    for (var j = 0; j < PRICING.deepseek.models[i].keys.length; j++) {
      if (m.indexOf(PRICING.deepseek.models[i].keys[j]) >= 0) return PRICING.deepseek.models[i].table;
    }
  }
  return null;
}
// 高峰判定：传了带 peakHours 的表就按表的时段；否则用 DeepSeek 全局规则。
export function isPeakHour(t) {
  var n = new Date();
  var h = n.getHours(), wd = n.getDay(); // 0=周日
  var ph = t && t.peakHours ? t.peakHours : PRICING.deepseek.peakHours;
  var weekendOff = t && typeof t.weekendOffPeak === "boolean" ? t.weekendOffPeak : PRICING.deepseek.weekendOffPeak;
  if (weekendOff && (wd === 0 || wd === 6)) return false;
  for (var i = 0; i < ph.length; i++) {
    if (h >= ph[i][0] && h < ph[i][1]) return true;
  }
  return false;
}
// 泛渠道条目匹配：条目须显式带 channel；keys 子串/exact 命中即用（条目顺序 = 优先级）。
// start/end（UTC 毫秒）可选：限时条目窗口外自动跳过，回退后续条目。
export function genericEntryFor(channel, model) {
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
      if (it.exact ? m === String(ks[j]).toLowerCase() : m.indexOf(String(ks[j]).toLowerCase()) >= 0) return it;
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// 通用 USD 渠道计价（OpenAI / Anthropic / Google）：美元刊例价，复用 tiers 阶梯
// ════════════════════════════════════════════════════════════
export var USD_CHANNELS = ["openai", "anthropic", "google"];
export function isUsdChannel(ch) { return USD_CHANNELS.indexOf(String(ch || "")) >= 0; }
export function usdEntryFor(channel, model) {
  var reg = PRICING.usd && PRICING.usd[channel];
  if (!reg || !reg.models) return null;
  var m = String(model || "").toLowerCase();
  for (var i = 0; i < reg.models.length; i++) {
    var ks = reg.models[i].keys || [];
    for (var j = 0; j < ks.length; j++) {
      if (!ks[j]) continue;
      if (reg.models[i].exact ? m === String(ks[j]).toLowerCase() : m.indexOf(String(ks[j]).toLowerCase()) >= 0) return reg.models[i];
    }
  }
  return null;
}
// 美元金额：((输入-缓存)×input + 缓存×cacheHit + 输出×output) / 1e6，按输入 token 选阶梯
export function calcUsd(channel, model, promptTok, completionTok, cacheHitTok) {
  var entry = usdEntryFor(channel, model);
  if (!entry) return null;
  var pt = promptTok || 0, ct = completionTok || 0;
  var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
  var tier = tpTier(entry, pt).tier;
  var cacheRate = tier.cacheHit != null ? tier.cacheHit : tier.input;
  return ((pt - hit) * tier.input + hit * cacheRate + ct * tier.output) / 1e6;
}

// ════════════════════════════════════════════════════════════
// Token Plan credits 计价引擎
// ════════════════════════════════════════════════════════════
// 北京时间小时（UTC+8 换算，与本机时区无关——用户在哪都按官方北京时段判）
export function beijingHour(t) {
  return new Date((t == null ? Date.now() : t) + 8 * 3600 * 1000).getUTCHours();
}
// Token Plan 官方夜间折扣窗口 [22, 8)：22:00–次日 08:00 北京
export function tpNightActive(t) {
  var w = PRICING.tokenplan.nightWindow || [22, 8];
  var h = beijingHour(t);
  return w[0] > w[1] ? h >= w[0] || h < w[1] : h >= w[0] && h < w[1];
}
export function tokenplanEntryFor(model) {
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
export function isTokenPlanAuto(model) { return modelBaseName(model) === "auto"; }
// 当前生效折扣系数与文案（预览期 × 夜间，官方明示可叠加：0.2×0.4=0.08）
export function tpFactor(entry, t) {
  var f = 1, notes = [];
  if (entry.preview && t >= entry.preview.start && t < entry.preview.end) {
    f *= entry.preview.factor;
    notes.push("预览期 " + Math.round(entry.preview.factor * 10) + " 折");
  }
  if (entry.night && tpNightActive(t)) {
    f *= entry.night;
    notes.push("夜间 " + (entry.night * 10).toFixed(1).replace(/\.0$/, "") + " 折");
  }
  return { factor: f, note: notes.join(" · ") };
}
// 按输入 token 数选阶梯（官方：单次请求的输入 Token 数决定档位）
export function tpTier(entry, promptTok) {
  var ts = entry.tiers;
  for (var i = 0; i < ts.length; i++) {
    if ((promptTok || 0) <= ts[i].upTo) return { tier: ts[i], idx: i };
  }
  return { tier: ts[ts.length - 1], idx: ts.length - 1 };
}
// 单条目 credits 计算（供主计算与 auto 区间共用）。返回三分量明细 + 折扣 + 估算标记。
export function tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t) {
  var pt = promptTok || 0, ct = completionTok || 0;
  var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
  var sel = tpTier(entry, pt);
  var tier = sel.tier;
  var cacheRate = tier.cacheHit != null ? tier.cacheHit : tier.input; // 未公布缓存价 → 按输入价估（面板标注）
  var fac = tpFactor(entry, t);
  var inCr = (pt - hit) * tier.input / 10000;
  var caCr = hit * cacheRate / 10000;
  var outCr = ct * tier.output / 10000;
  return {
    credits: (inCr + caCr + outCr) * fac.factor,
    input: inCr * fac.factor, cache: caCr * fac.factor, output: outCr * fac.factor,
    factor: fac.factor, factorNote: fac.note, tierIdx: sel.idx,
    cacheAssumed: tier.cacheHit == null && hit > 0,
    assumedBase: !!entry.assumedBase
  };
}
// Token Plan 主计算：渠道不对/模型不在表 → null（不猜）。auto → null（走区间）。
export function calcTokenPlan(model, promptTok, completionTok, cacheHitTok, t) {
  if (isTokenPlanAuto(model)) return null;
  var entry = tokenplanEntryFor(model);
  if (!entry) return null;
  return tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t == null ? Date.now() : t);
}
// auto 智能路由：底层模型不定 → 给全表当前时刻的 [min, max] 参考区间（不假装精确，同别名口径）
export function calcTokenPlanRange(model, promptTok, completionTok, cacheHitTok, t) {
  if (!isTokenPlanAuto(model)) return null;
  var ms = PRICING.tokenplan.models, lo = null, hi = null;
  var tt = t == null ? Date.now() : t;
  for (var i = 0; i < ms.length; i++) {
    var c = tpCalcEntry(ms[i], promptTok, completionTok, cacheHitTok, tt).credits;
    if (lo == null || c < lo) lo = c;
    if (hi == null || c > hi) hi = c;
  }
  if (lo == null) return null;
  return { lo: lo, hi: hi };
}
// 百炼按量（dashscope 渠道，人民币）：同一张刊例价表，单位换回元/百万tok。
// 仅 bailianPeak 标记的模型按忙/闲时（忙 08–22 北京，闲时=忙时×night）；其余模型恒刊例价。
// Token Plan 的夜间/预览折扣不适用于按量渠道（两套体系，官方明示相互独立）。
export function calcDashscope(model, promptTok, completionTok, cacheHitTok, t) {
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

// 计价：deepseek 渠道用官方价表；tokenplan 用 credits 表；dashscope 用刊例价按量；其他渠道查 generic.models
// ——条目带 coef → 套餐模式；带 table → 按量模式。没配条目 → null，不猜。
export function calcCost(channel, model, promptTok, completionTok, cacheHitTok) {
  var ch = String(channel || "");
  if (ch === "afp") ch = "plan"; // 旧历史数据渠道名兼容
  if (!ch || ch === "plan") return null; // 套餐渠道的额度走 calcPlan，不在这里
  if (ch === "tokenplan") {
    var tp = calcTokenPlan(model, promptTok, completionTok, cacheHitTok);
    return tp ? tp.credits : null;
  }
  if (ch === "dashscope") return calcDashscope(model, promptTok, completionTok, cacheHitTok);
  if (isUsdChannel(ch)) return calcUsd(ch, model, promptTok, completionTok, cacheHitTok);
  var pt = promptTok || 0, ct = completionTok || 0;
  var t = ch === "deepseek" ? priceTableFor(model) : (genericEntryFor(ch, model) || {}).table;
  if (t && t.offPeak && t.offPeak.input != null && t.offPeak.output != null) {
    var p = t.peak && isPeakHour(t) ? t.peak : t.offPeak;
    var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
    var inPrice = p.cacheHit != null ? p.cacheHit : p.input;
    return (hit / 1e6) * inPrice + (Math.max(0, pt - hit) / 1e6) * p.input + (ct / 1e6) * p.output;
  }
  // 套餐模式条目（coef）——任意自定义渠道可按套餐额度计费
  var e = genericEntryFor(ch, model);
  if (e && e.coef != null) return ((pt + ct) * e.coef) / 10000;
  return null;
}
// 该渠道金额的显示单位：plan=套餐额度 / cny=人民币 / credits=百炼 Credits。旧数据无此字段按 cny 显示
export function costUnitFor(channel, model) {
  var ch = String(channel || "");
  if (ch === "afp") ch = "plan";
  if (!ch || ch === "plan") return "";
  if (ch === "deepseek" || ch === "dashscope") return "cny";
  if (isUsdChannel(ch)) return "usd";
  if (ch === "tokenplan") return "credits";
  var e = genericEntryFor(ch, model);
  return e && e.coef != null ? "plan" : "cny";
}

// 渠道是否配置过价表（决定"无价表"提示是否出现）
export function channelHasPriceTable(ch) {
  var c = String(ch || "").toLowerCase();
  if (c === "afp") c = "plan";
  if (!c) return false;
  if (c === "deepseek" || c === "tokenplan" || c === "dashscope") return true;
  if (isUsdChannel(c)) return true;
  if (c === "plan") return false; // 套餐渠道走 coefMissing 提示，不算"无价表"
  var g = (PRICING.generic && PRICING.generic.models) || [];
  for (var i = 0; i < g.length; i++) {
    if (g[i] && String(g[i].channel || "").toLowerCase() === c && (g[i].table || g[i].coef != null)) return true;
  }
  return false;
}

// 金额相关字段（bar/面板/实时快照共用一份口径，避免三处漂移）
// tokenplan 渠道返回 tp 三分量明细/折扣/阶梯/估算标记；auto 给 tpLo/tpHi 参考区间
export function moneyFields(channel, model, promptTok, completionTok, cacheHitTok) {
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
    // 渠道配过价表但这模型算不出钱 → 面板提示"无价表"（auto 有区间时不算缺）
    priceMissing: channelHasPriceTable(chN) && cost == null && !tpRange,
    provider: (store.activeLlm && store.activeLlm.providerId) || "",
    // Token Plan 明细（其他渠道为 null，UI 判空渲染）
    tp: tp,
    tpLo: tpRange ? tpRange.lo : null,
    tpHi: tpRange ? tpRange.hi : null,
    tpRange: !!tpRange
  };
}
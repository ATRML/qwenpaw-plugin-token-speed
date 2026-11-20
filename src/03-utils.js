  // ════════════════════════════════════════════════════════════
  // 03-utils.js · 格式化工具 / 一次性告警 / 缓存重计标注 / 相对时间
  // ════════════════════════════════════════════════════════════
  // ---------- 工具 ----------
  function now() { return performance.now(); }

  function fmtMs(ms) {
    if (!ms) return "-";
    return ms < 1000 ? ms.toFixed(0) + "ms" : (ms / 1000).toFixed(2) + "s";
  }

  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "-";
    return n >= 1000000 ? (n / 1000000).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toLocaleString("zh-CN");
  }

  function fmtSpeed(n) {
    if (n == null || !isFinite(n)) return "-";
    return (n > 0 ? "≈" : "") + n.toFixed(1);
  }

  function fmtSec(s) {
    if (!s || s < 0) return "-";
    if (s < 60) return s.toFixed(1) + "s";
    return (s / 60).toFixed(1) + "min";
  }

  // v1.5.0：一次性告警（此前 DOM 选择器失效静默降级，前端改版坏了自己都不知道）
  var warnedOnce = {};
  function warnOnce(key, msg) {
    if (warnedOnce[key]) return;
    warnedOnce[key] = true;
    try { console.warn("[token-speed] " + msg); } catch (e) { /* ignore */ }
  }

  // v1.5.0：微额自适应精度（旧 toFixed(4)/toFixed(2) 会把 ¥0.0000465 显示成 ¥0.0000）
  function fmtMoney(v, unit) {
    if (v == null || !isFinite(v)) return "-";
    return (unit || "") + (v >= 0.01 ? v.toFixed(4) : v.toFixed(6));
  }
  function fmtPlan(v) {
    if (v == null || !isFinite(v)) return "-";
    return v >= 0.05 ? v.toFixed(2) : v.toFixed(4);
  }
  // v1.20.0 Credits 格式化：与额度同量纲（credits/万tok 数值 = 元/百万tok 刊例价），精度规则一致；
  // 大额（>=1000）收 1 位小数，避免长数字撑破 chip
  function fmtCredits(v) {
    if (v == null || !isFinite(v)) return "-";
    if (v >= 1000) return v.toFixed(1);
    return v >= 0.05 ? v.toFixed(2) : v.toFixed(4);
  }
  // v1.20.0 刊例价折算：1 credit = 0.01 元刊例价（官方换算的数学推论），credits → 元
  function creditsToCny(v) { return (v == null || !isFinite(v)) ? null : v / 100; }

  // v1.5.0：缓存重计标注（v1.8.0 起只在套餐渠道显示——缓存重计是套餐计费规则，人民币
  // 渠道按缓存价另算，不适用）。实测（2026-09-16 对账）：套餐缓存命中按全额系数重复计费
  // ——5小时窗实际扣费 1290.33 ≈ 全额公式预测 1440；大上下文回合 90%+ 的套餐额度来自缓存
  // 重计（27步回合：1271.56 里 1177 是重计）
  // v1.19.0：旧历史数据渠道名 "afp" 一并认（新代号 "plan"）
  function rebillNote(channel, cacheHitTok, model) {
    if (channel !== "plan" && channel !== "afp") return "";
    var c = planCoef(model);
    if (!c || !cacheHitTok || cacheHitTok <= 0) return "";
    var rebill = cacheHitTok * c / 10000;
    if (rebill < 0.05) return "";
    return "（缓存重计 " + fmtPlan(rebill) + "）";
  }

  // 历史结果距今的相对时间（>10 分钟且有可靠 ts 才显示；
  // v1.0.x 存的结果无 ts 字段，绝不能拿 Date.now()-0 当年龄 → "20709天前"事故）
  function fmtAge(r) {
    if (!r || typeof r.ts !== "number" || !(r.ts > 0)) return "";
    var age = Date.now() - r.ts;
    if (age <= 10 * 60 * 1000) return ""; // 10 分钟内视为"刚结束"，不标注
    var m = Math.floor(age / 60000);
    if (m < 60) return m + "分钟前";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "小时前";
    return Math.floor(h / 24) + "天前";
  }

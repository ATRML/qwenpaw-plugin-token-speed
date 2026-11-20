/**
 * QwenPaw 插件：Token 实时速度（前端核心）
 * - 拦截聊天 SSE 流（POST /api/console/chat，响应为 text/event-stream）
 * - 统计：首字延迟 TTFT、实时 token 速度、本轮 token 总量、耗时、工具等待、费用（套餐额度/人民币）
 * - 显示为固定悬浮条（输入框上方），不进入 React 管理树；点击悬浮条展开详情面板
 *   （大号分段速度折线图 + 分段明细 + 完整汇总）
 *
 * 本文件由 build.py 从 src/*.js 拼接生成，请勿直接手改 dist/index.js。
 * 调价只改 src/06-pricing.js 顶部的 PRICING 静态数据区。
 * 版本史见 CHANGELOG.md。
 */
(function () {
  "use strict";

  // 防重复注入：插件被加载两次时避免双层 fetch patch → 每个事件统计两遍
  if (window.__qpTokenSpeedLoaded) return;
  window.__qpTokenSpeedLoaded = true;

  window.__qpTokenSpeedVersion = "1.20.0";

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

  // ════════════════════════════════════════════════════════════
  // 02-state.js · 会话状态（createState / LRU / 流纪元 epoch）
  // ════════════════════════════════════════════════════════════
  // ---------- 状态（每会话一个 state） ----------
  function createState(sid) {
    return {
      __sid: sid,
      active: false,
      t0: 0, tFirst: 0, ttft: 0,
      charCount: 0, tokenCount: 0, estimatedTokens: 0, peakMax: 0,
      // v1.12.0：工具调用参数（type:"data" 帧的 data.arguments 分片）单列统计——
      // 后端 completion_tokens 本就含这块（实测约占输出 30%），但不并入正文速度/分段
      toolCharCount: 0, toolEstTokens: 0, toolTokens: 0,
      // v1.13.0：语义分段用工具边界；epoch 为流纪元（双流竞态丢弃旧流）
      toolPending: false, toolStartT: 0, epoch: 0,
      toolCalls: Object.create(null), textSnapshots: Object.create(null),
      idleAccountedUntil: 0, requestSessionId: "",
      explicitReplay: false, replayToolTokens: 0, suspended: false,
      originT0: 0, originKnown: true, messageId: "", snapshotFallback: false,
      toolMessageCalls: Object.create(null), finishedTools: Object.create(null),
      modelWaitMs: 0, toolResumeAt: 0,
      // v1.13.1：批量冲刷判定 + 诊断（最大单片 / 回放结束原因 / 冲刷计数）
      evWin: [], flushPeak: false, diagMax: null, diagReplayEnd: "", diagFlushAfterSilent: 0,
      // v1.14.1：原始峰值（不做冲刷剔除，诊断 + "峰值≥平均"兜底）/ 被跳过的疑似冲刷数
      peakRaw: 0, flushSkipped: 0,
      totalTokens: 0, promptTokens: 0, cacheHitTokens: 0, model: "",
      seenFullText: "",
      tLast: 0, eventCount: 0,
      segments: [], currentSeg: null, pauseMs: 0,
      window: [], fullText: "",
      finalUsage: null, lastTouched: 0, lastResult: null,
      // v1.6.0 中途接入（切换/打开对话时的回放补发）识别
      attached: false, replayDone: false, replayTokens: 0, replayLastT: 0,
      replayWin: [], probeT0: 0, probeTokens: 0, probeWin: [],
      liveTokens: 0, liveStartT: 0, totalGenerated: 0,
      // v1.7.0：面板实时刷新要用的实时速率 / 后端显式回放结束标记
      lastSpeed: 0, replayEndSeen: false,
      // v1.20.0：实时速度 sparkline 环形缓冲 [t, speed]（面板头图用，tick 采样，上限 120 点）
      speedHist: [], lastSpeedSampleT: 0,
      // v1.8.0 计费渠道与收尾取证
      providerUsage: "",   // 本回合 SSE usage 里带的 provider_id（最准证据）
      channel: "",         // plan / deepseek / other / ""（未识别）
      channelSrc: "",      // usage / active / model / memory（证据强度排序用）
      provider: "",        // 用于显示的渠道来源（provider_id）
      endCause: "",        // stream_end / error_frame / read_error / user_stop
      errMsg: "",          // 异常结束原因（截断保存，hover 可见）
      lastEventAt: 0,      // 最后一个 SSE 事件时刻（延迟判定 error 帧用）
      pendingError: "",    // 待判定的流内 error 帧（1.6s 内有新事件就忽略）
      userStopped: false   // 用户点了停止（POST /console/chat/stop）
    };
  }
  var states = {};
  var STATE_MAX = 12; // 驻留内存的会话 state 上限（LRU）
  // v1.13.0：单调递增的流纪元。同一会话"停止→立即重发"会出现新旧两条流并存，
  // 旧流迟到的事件/中断/收尾必须丢弃，否则会把新回合误判成"出错"（评审 P0-1）
  var streamEpoch = 0;

  function getState(sid) {
    if (!states[sid]) states[sid] = createState(sid);
    states[sid].lastTouched = Date.now();
    return states[sid];
  }
  function pruneStates() {
    var keys = Object.keys(states);
    if (keys.length <= STATE_MAX) return;
    var removable = keys.filter(function (k) { return states[k] && !states[k].active; });
    removable.sort(function (a, b) { return (states[a].lastTouched || 0) - (states[b].lastTouched || 0); });
    for (var i = 0; i < removable.length && Object.keys(states).length > STATE_MAX; i++) {
      delete states[removable[i]];
    }
  }
  function getActiveStream(sid) {
    var st = states[sid];
    return st && st.active ? st : null;
  }

  // v1.14.0 共用 helper（原逻辑在 5 处内联重复，语义一致，摘出防漂移）：
  // 2s 滑动窗口：推入 [t, 累计值] 并裁掉窗口外的旧点（速度/峰值/回放探测共用）
  function pushWin(win, t, v) {
    win.push([t, v]);
    while (win.length && t - win[0][0] > 2000) win.shift();
  }
  // 收尾当前正文段：段末 = 最后一个正文 delta 时刻（停顿/工具等待不摊进段时长）。
  // 段为空（tokens=0）时不入列；调用方若要"只在非空时收"请自行先判 tokens>0。
  function closeCurrentSeg(st, tEnd) {
    if (st.currentSeg && st.currentSeg.tokens > 0) {
      if (st.tLast) st.currentSeg.t1 = st.tLast;
      else if (tEnd != null) st.currentSeg.t1 = tEnd;
      st.segments.push(st.currentSeg);
    }
    st.currentSeg = null;
  }
  // The first packet has no observable decode interval. Never divide its tokens
  // by the later packets' time, and never assign a speed to a one-packet segment.
  function measuredSegTokens(seg) {
    return Math.max(0, seg.tokens - (seg.firstTokens || 0) - (seg.flushTokens || 0));
  }

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

  // ════════════════════════════════════════════════════════════
  // 04-tokens.js · token 估算（中英混合 + 按模型 ratio 自校准）/ usage 提取
  // ════════════════════════════════════════════════════════════
  // 中英混合 token 估算：中文字符≈1 token，其他字符≈1/4 token，空白忽略
  // v1.5.0：ratio 按模型分表——不同模型的真实压缩比差一倍（glm-5.3 思考流
  // completion/估算≈0.5，flash≈0.9），全局单一 ratio 会互相污染校准
  var RATIO_KEY = "qp_token_speed_ratio";           // 旧标量：作为未知模型的回退
  var RATIO_MAP_KEY = "qp_token_speed_ratio_map";    // 新：{模型小写: ratio}
  var defaultRatio = 1;
  var ratioMap = {};
  try {
    var _rm = JSON.parse(localStorage.getItem(RATIO_MAP_KEY) || "null");
    if (_rm && typeof _rm === "object") ratioMap = _rm;
    defaultRatio = parseFloat(localStorage.getItem(RATIO_KEY)) || 1;
  } catch (e) { /* ignore */ }

  function ratioFor(model) {
    model = String(model || "").toLowerCase();
    if (model && ratioMap[model]) return ratioMap[model];
    return defaultRatio;
  }
  function calibrateRatio(model, newRatio) {
    var old = (model && ratioMap[model]) || defaultRatio;
    var v = old * 0.7 + newRatio * 0.3;
    if (model) {
      ratioMap[model] = v;
      try { localStorage.setItem(RATIO_MAP_KEY, JSON.stringify(ratioMap)); } catch (e) { /* ignore */ }
    } else {
      defaultRatio = v;
      try { localStorage.setItem(RATIO_KEY, defaultRatio.toFixed(4)); } catch (e) { /* ignore */ }
    }
  }

  function rawEstimate(text) {
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) { cjk++; }
      else if (code > 0x20 && code !== 0x7f) { other++; }
    }
    return cjk + other / 4;
  }
  function estimateTokens(text, model) { return rawEstimate(text) * ratioFor(model); }

  // 从事件里提取精确用量
  function extractUsage(obj) {
    if (!obj || typeof obj !== "object") return null;
    var usage = obj.usage || (obj.data && obj.data.usage) || null;
    var model = obj.model || (obj.data && obj.data.model) || "";
    if (usage && typeof usage === "object") {
      var pt = usage.prompt_tokens, ct = usage.completion_tokens;
      function count(n) { return typeof n === "number" && isFinite(n) && n >= 0; }
      var exact = obj.type === "turn_usage" && usage.estimated !== true;
      if (pt !== undefined && !count(pt) || ct !== undefined && !count(ct)) return null;
      var hit = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens
              : typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : 0;
      var mName = usage.model_name || model || "";
      // v1.8.0：usage 里带的 provider_id 是"本回合真实渠道"的最强证据（后端日志实测
      // 形如 provider_id/model_name/prompt_tokens/cache_read_tokens/...；后端估算型
      // usage 的这两个字段会是空串，那就别拿它下结论）
      var prov = typeof usage.provider_id === "string" ? usage.provider_id : "";
      if (count(pt) && count(ct)) {
        var total = count(usage.total_tokens) ? usage.total_tokens : pt + ct;
        if (total < pt + ct) return null;
        hit = count(hit) ? Math.min(hit, pt) : 0;
        return { generated: ct, total: total, promptTokens: pt, completionTokens: ct, cacheHit: hit, model: mName, provider: prov, exact: exact };
      }
      var it = usage.input_tokens, ot = usage.output_tokens;
      if (count(it) && count(ot)) {
        return { generated: ot, total: it + ot, promptTokens: it, completionTokens: ot, cacheHit: 0, model: mName, provider: prov, exact: exact };
      }
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════
  // 05-channel.js · 计费渠道判定（provider 三级证据链 / active_llm / providerMap）
  // ════════════════════════════════════════════════════════════
  // ---------- 计费渠道（v1.8.0） ----------
  // 病根（用户实测反馈："明明用的 DeepSeek，为啥显示套餐抵扣"）：模型名无法决定计费渠道
  // ——同一个 deepseek-v4-flash，在套餐渠道（Agent Plan，按额度抵扣）与 DeepSeek 官方
  // （人民币按量）都在卖，旧逻辑看名字就套套餐系数（还把它写进了套餐系数表），于是官方
  // 按量的回合被算成套餐抵扣。渠道必须按 provider 判：
  //   provider_id 含 agentplan / base_url 含 /api/plan/  → plan（套餐渠道，按额度抵扣）
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

  // 渠道判定：只认 provider 证据，拿不到证据返回 ""（而不是默认套餐抵扣——那正是旧 bug）
  function resolveChannel(providerId, baseUrl) {
    var pid = String(providerId || "").toLowerCase();
    var bu = String(baseUrl || "").toLowerCase();
    // 顺序关键：/api/coding 必须在 /api/plan 前判（两者都可能含 "coding" 无关，但 base 不重叠，保险起见先判）
    if (/\/api\/coding(\/|$)/.test(bu) || /coding[_\-]?plan/.test(pid)) return "coding";
    if (/agentplan|agent-plan|agent_plan/.test(pid) || /\/api\/plan\//.test(bu)) return "plan";
    // v1.20.0 阿里云百炼 Token Plan：专属端点 token-plan.<region>.maas.aliyuncs.com，
    // 或 provider 名含 tokenplan/token-plan/token_plan。base_url 证据优先——同一个 qwen 模型名
    // 在百炼按量/Token Plan/其他渠道都在卖，只认端点不认名字（与 v1.8.0 修 DeepSeek 误判同一原则）
    if (/token[-_]?plan/.test(pid) || bu.indexOf("token-plan.") >= 0 || bu.indexOf("maas.aliyuncs.com") >= 0) return "tokenplan";
    if (pid === "deepseek" || pid.indexOf("deepseek") >= 0 || bu.indexOf("deepseek.com") >= 0) return "deepseek";
    // v1.20.0 阿里云 Coding Plan 专属端点 coding.dashscope.aliyuncs.com（与 /api/coding 同渠道，不套金额表）
    if (bu.indexOf("coding.dashscope") >= 0) return "coding";
    // v1.20.0 百炼按量付费（dashscope.aliyuncs.com 通用端点 / provider 名含 dashscope|bailian）：
    // 人民币刊例价计价，与 Token Plan 的 credits 体系独立（官方明示两套额度不互通）
    if (bu.indexOf("dashscope.aliyuncs.com") >= 0 || /dashscope|bailian/.test(pid)) return "dashscope";
    // v1.18.0：自定义渠道映射（纯数据：PRICING.customChannels，可经 localStorage 覆盖层注入）——
    // provider_id/base_url 命中子串 → 返回配置的渠道名；没配置/没命中照旧落 other
    var _cc = customChannelOf(pid, bu);
    if (_cc) return _cc;
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
    // provider_id 本身就能定性（套餐渠道 / DeepSeek 官方 / 百炼系）就不用去拉 base_url 了；
    // 只有"认不出"的自定义 provider（例如 huoshanahent 这种）才需要 base_url 佐证
    var ch0 = resolveChannel(activeLlm.providerId, "");
    if (ch0 === "plan" || ch0 === "deepseek" || ch0 === "coding" || ch0 === "tokenplan" || ch0 === "dashscope") return;
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
          applyBillingRetro(true); // base_url 证据刚到位：允许 other → plan/deepseek 的升级
        })
        .catch(function () { mapFetching = false; });
    } catch (e) { mapFetching = false; }
  }

  // ════════════════════════════════════════════════════════════
  // 06-pricing.js · PRICING 价目表静态数据区 + 套餐额度/人民币/Credits/区间计算
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
  //   PRICING.tokenplan.models    ★ v1.20.0 阿里云百炼 Token Plan（credits 计价，见下方专节）
  // 运行时覆盖层（v1.18.0 建 / v1.19.0 扩展 / v1.20.0 加 tokenplan）：localStorage["qp_token_speed_pricing"]
  //   放一份 JSON 即可加模型/调价/接渠道，不用改源码重建；用户条目合并进对应表且排在最前（优先命中），
  //   解析/结构异常整份忽略并 console.warn，内置表原样生效。
  // 数据来源：官方计费规格文档（对拍示例：seed-2.1-turbo 50k入/0.5k出 → 12.625 额度）
  //          + 官方核对文档 2026-09-16 + DeepSeek 2026-09-10 调价
  //          + 百炼 Token Plan 用量与额度页官方对拍示例 + 百炼模型价格页刊例价（2026-11-20 核对）
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
    customChannels: [],
    // ════════════════════════════════════════════════════════════════════
    // ★ v1.20.0 阿里云百炼 Token Plan（credits）与百炼按量（dashscope，人民币）
    //
    // 官方换算（用量与额度页 qwen3.6-plus 对拍示例实证）：
    //   输入 8349 tok → 1.67 credits  ⇒ 2 credits/万tok
    //   缓存 40794 tok → 0.82 credits ⇒ 0.2 credits/万tok
    //   输出 573 tok → 0.69 credits   ⇒ 12 credits/万tok
    // 即 credits/万tok 的数值 = 刊例价 元/百万tok 的数值（1 credit = 0.01 元刊例价）。
    // 因此 tiers 里的 input/output/cacheHit 直接填百炼模型价格页（华北2北京）刊例价数字。
    //
    // 结构：{ keys, exact?, tiers:[{upTo, input, output, cacheHit?}], night?, preview?, bailianPeak?, assumedBase? }
    //   tiers     按"单次请求输入 token 数"阶梯计价（官方 plus/flash/glm-5.1/glm-5 有阶梯）；
    //             upTo=Infinity 表示不分阶梯。cacheHit 缺省 = 官方未公布缓存单价 → 缓存部分按输入价估（面板标注）。
    //   night     Token Plan 官方夜间折扣（北京 22:00–次日 08:00，整单 credits 乘系数）：
    //             qwen3.8-max/flash 4 折；deepseek-v4-pro-0813/v4-flash-0731/v4.1-flash(-1017) 5 折。
    //             ※ 对拍洞察：deepseek 系 5 折 × 忙时刊例价 恰等于其闲时刊例价（2×0.5=1、8×0.5=4、
    //             9×0.5=4.5、27×0.5=13.5、3×0.5=1.5、9×0.5=4.5），故 base 填忙时价 + night:0.5 自洽。
    //   preview   qwen4-max-preview 预览期官方 2 折（2026-11-11 10:00 ~ 11-25 24:00 北京），夜间再 4 折
    //             （官方明示叠加后 0.8 折 = 0.2×0.4）。预览版无独立刊例价，按 qwen4-max 刊例价计（assumedBase 标注）。
    //   bailianPeak  百炼按量渠道（dashscope）专用：该模型按忙/闲时计价（忙 08:00–22:00 北京），
    //             闲时价 = 忙时价 × night。Token Plan 渠道不受此标记影响（走 night 折扣语义）。
    //   assumedBase  刊例价为同系推断（仅预览版），面板会标注"估算"。
    // 数组顺序 = 匹配优先级：长名/带后缀的排前面（qwen4-max-preview 先于 qwen4-max，
    //   deepseek-v4-pro-0813 先于 deepseek-v4-pro，glm-5.3/5.2/5.1 先于 glm-5）。
    // 未入表的 Token Plan 模型（图像/视频/语音/decision-model-preview 等）→ 不显示金额（不猜）。
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
  // v1.20.0：Token Plan 个人版套餐档位（官方 2026-11-16 页：Pro 降价至 312 元/月、额度上调）
  // 用于面板"套餐摊销"：credits × (月费/月额度) = 按订阅实际付出的人民币成本
  var TP_PLANS = [
    { id: "lite", name: "Lite", price: 39, quota: 20000 },
    { id: "essential", name: "Essential", price: 79, quota: 45000 },
    { id: "standard", name: "Standard", price: 139, quota: 80000 },
    { id: "pro", name: "Pro", price: 312, quota: 200000 }
  ];
  // v1.18.0 · 运行时覆盖层（v1.19.0 扩展 / v1.20.0 加 tokenplan.models）：
  // localStorage["qp_token_speed_pricing"] 放一份 JSON 即可加模型/调价/接渠道，不用改源码重建。
  // 用户条目合并进对应表并排在最前（优先命中）；JSON 解析失败/结构不对 → 整份忽略并 console.warn，
  // 内置表原样生效，绝不因此崩面板。支持字段：
  //   plan.base / plan.promo（旧键名 afp.* 仍兼容）/ deepseek.models（数组，前置合并）、
  //   deepseek.peakHours（替换）、deepseek.weekendOffPeak（替换）、alias.keys（前置合并）、
  //   generic.models / customChannels（整体提供）、tokenplan.models（前置合并，须带合法 tiers）
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
    // v1.20.0：tokenplan 条目必须带 tiers 数组且每档 input/output 为数字（防坏覆盖层把计价算崩）
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
      if (u.afp && entryArr(u.afp.base)) PRICING.plan.base = u.afp.base.concat(PRICING.plan.base); // v1.19.0 前旧键名兼容
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

  // ════════════════════════════════════════════════════════════
  // v1.20.0 · Token Plan credits 计价引擎
  // ════════════════════════════════════════════════════════════
  // 北京时间小时（UTC+8 换算，与本机时区无关——用户在哪都按官方北京时段判）
  function beijingHour(t) {
    return new Date((t == null ? Date.now() : t) + 8 * 3600 * 1000).getUTCHours();
  }
  // Token Plan 官方夜间折扣窗口 [22, 8)：22:00–次日 08:00 北京
  function tpNightActive(t) {
    var w = PRICING.tokenplan.nightWindow || [22, 8];
    var h = beijingHour(t);
    return w[0] > w[1] ? (h >= w[0] || h < w[1]) : (h >= w[0] && h < w[1]);
  }
  function tokenplanEntryFor(model) {
    if (!model) return null;
    var m = String(model).toLowerCase();
    var ms = PRICING.tokenplan.models;
    for (var i = 0; i < ms.length; i++) {
      var ks = ms[i].keys || [];
      for (var j = 0; j < ks.length; j++) {
        if (!ks[j]) continue;
        if (ms[i].exact ? (m === String(ks[j]).toLowerCase()) : (m.indexOf(String(ks[j]).toLowerCase()) >= 0)) return ms[i];
      }
    }
    return null;
  }
  function isTokenPlanAuto(model) { return modelBaseName(model) === "auto"; }
  // 当前生效折扣系数与文案（预览期 × 夜间，官方明示可叠加：0.2×0.4=0.08）
  function tpFactor(entry, t) {
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
  function tpTier(entry, promptTok) {
    var ts = entry.tiers;
    for (var i = 0; i < ts.length; i++) {
      if ((promptTok || 0) <= ts[i].upTo) return { tier: ts[i], idx: i };
    }
    return { tier: ts[ts.length - 1], idx: ts.length - 1 };
  }
  // 单条目 credits 计算（供主计算与 auto 区间共用）。返回三分量明细 + 折扣 + 估算标记。
  function tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t) {
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
  function calcTokenPlan(model, promptTok, completionTok, cacheHitTok, t) {
    if (isTokenPlanAuto(model)) return null;
    var entry = tokenplanEntryFor(model);
    if (!entry) return null;
    return tpCalcEntry(entry, promptTok, completionTok, cacheHitTok, t == null ? Date.now() : t);
  }
  // auto 智能路由：底层模型不定 → 给全表当前时刻的 [min, max] 参考区间（不假装精确，同别名口径）
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
    return { lo: lo, hi: hi };
  }
  // 百炼按量（dashscope 渠道，人民币）：同一张刊例价表，单位换回元/百万tok。
  // 仅 bailianPeak 标记的模型按忙/闲时（忙 08–22 北京，闲时=忙时×night，与官方闲时价对拍一致）；
  // 其余模型恒刊例价。Token Plan 的夜间/预览折扣不适用于按量渠道（两套体系，官方明示相互独立）。
  function calcDashscope(model, promptTok, completionTok, cacheHitTok, t) {
    var entry = tokenplanEntryFor(model);
    if (!entry) return null;
    var tt = t == null ? Date.now() : t;
    var pt = promptTok || 0, ct = completionTok || 0;
    var hit = Math.max(0, Math.min(cacheHitTok || 0, pt));
    var tier = tpTier(entry, pt).tier;
    var f = (entry.bailianPeak && tpNightActive(tt)) ? entry.night : 1;
    var cacheRate = tier.cacheHit != null ? tier.cacheHit : tier.input;
    return ((pt - hit) * tier.input + hit * cacheRate + ct * tier.output) / 1e6 * f;
  }

  // 计价（v1.18.0 泛化 / v1.19.0 补完 / v1.20.0 加 tokenplan/dashscope）：
  // deepseek 渠道用官方价表；tokenplan 用 credits 表；dashscope 用刊例价按量；其他渠道查 PRICING.generic.models
  // ——条目带 coef → 套餐模式（额度=(入+出)×系数/10000，与 plan 渠道同口径）；带 table → 按量模式
  // （元/百万；cacheHit/peak 可选：缺 cacheHit 按输入价计缓存部分，缺 peak 恒低谷）。没配条目 → null，不猜。
  function calcCost(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan"; // 旧历史数据渠道名兼容
    if (!ch || ch === "plan") return null; // 套餐渠道的额度走 calcPlan，不在这里
    if (ch === "tokenplan") {
      var tp = calcTokenPlan(model, promptTok, completionTok, cacheHitTok);
      return tp ? tp.credits : null;
    }
    if (ch === "dashscope") return calcDashscope(model, promptTok, completionTok, cacheHitTok);
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
  // 该渠道金额的显示单位（v1.19.0 / v1.20.0 加 credits）：plan=套餐额度 / cny=人民币 / credits=百炼 Credits
  // 旧数据无此字段按 cny 显示，零迁移
  function costUnitFor(channel, model) {
    var ch = String(channel || "");
    if (ch === "afp") ch = "plan";
    if (!ch || ch === "plan") return "";
    if (ch === "deepseek" || ch === "dashscope") return "cny";
    if (ch === "tokenplan") return "credits";
    var e = genericEntryFor(ch, model);
    return (e && e.coef != null) ? "plan" : "cny";
  }

  // 渠道是否配置过价表（决定"无价表"提示是否出现；v1.18.0 泛化：泛渠道表也算数；v1.19.0 计入 coef 条目）
  function channelHasPriceTable(ch) {
    var c = String(ch || "").toLowerCase();
    if (c === "afp") c = "plan";
    if (!c) return false;
    if (c === "deepseek" || c === "tokenplan" || c === "dashscope") return true;
    if (c === "plan") return false; // 套餐渠道走 coefMissing 提示，不算"无价表"
    var g = (PRICING.generic && PRICING.generic.models) || [];
    for (var i = 0; i < g.length; i++) {
      if (g[i] && String(g[i].channel || "").toLowerCase() === c && (g[i].table || g[i].coef != null)) return true;
    }
    return false;
  }

  // 金额相关字段（bar/面板/实时快照共用一份口径，避免三处漂移）
  // v1.19.0：channel 入参先归一（旧历史数据 "afp" → "plan"）再查价；新增 costUnit 供 UI 选单位
  // v1.20.0：tokenplan 渠道返回 tp 三分量明细/折扣/阶梯/估算标记；auto 给 tpLo/tpHi 参考区间
  function moneyFields(channel, model, promptTok, completionTok, cacheHitTok) {
    var ch = channel || "";
    var chN = (ch === "afp") ? "plan" : ch;
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
      provider: (activeLlm && activeLlm.providerId) || "",
      // v1.20.0 Token Plan 明细（其他渠道为 null，UI 判空渲染）
      tp: tp,
      tpLo: tpRange ? tpRange.lo : null,
      tpHi: tpRange ? tpRange.hi : null,
      tpRange: !!tpRange
    };
  }

  // ════════════════════════════════════════════════════════════
  // 07-model.js · 模型名获取（active_llm → DOM 兜底）/ completed 全文提取
  // ════════════════════════════════════════════════════════════
  // 模型名：usage.model_name 常为空 → 退到 /api/models/active 的真实模型，再退 DOM
  function getCurrentModel() {
    if (activeLlm && activeLlm.model) return activeLlm.model;
    return getDomModel();
  }
  // SSE 事件里不一定带 model，兜底从顶部 header DOM 读（v1.5.0 起仅作最后兜底）
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
    } catch (e) { /* ignore */ }
    return "";
  }

  // 从 completed message 事件提取完整文本
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

  // ════════════════════════════════════════════════════════════
  // 08-turn.js · 回合生命周期：startTurn / addDelta（回放识别）/ handleEvent
  // ════════════════════════════════════════════════════════════
  // ---------- 统计（全部显式传 st；多流并发安全） ----------

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
      st.window = []; st.evWin = []; st.lastSpeed = 0;
    }
    st.toolCalls[callId] = true;
  }
  function completeTool(st, callId, t) {
    if (!st.toolCalls[callId]) return;
    delete st.toolCalls[callId]; st.finishedTools[callId] = true;
    if (Object.keys(st.toolCalls).length) return;
    var replaying = st.attached && !st.replayDone;
    if (!replaying && st.toolStartT) st.pauseMs += Math.max(0, t - st.toolStartT);
    st.toolPending = false; st.toolStartT = 0;
    st.tLast = 0; st.idleAccountedUntil = 0;
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
    st.epoch = epoch || 0; // v1.13.0：本回合所属流纪元（旧流事件据此丢弃）
    st.lastTouched = Date.now();
    st.t0 = (typeof origin === "number") ? origin : now();
    st.tFirst = 0;
    st.ttft = 0;
    st.charCount = 0;
    st.tokenCount = 0;
    st.estimatedTokens = 0;
    st.peakMax = 0;
    st.peakRaw = 0;        // v1.14.1：未剔除冲刷的原始峰值
    st.flushSkipped = 0;   // v1.14.1：看着像冲刷、实为连续流而未剔除的次数
    st.toolCharCount = 0; // v1.12.0 工具参数逐轮重置
    st.toolEstTokens = 0;
    st.toolTokens = 0;
    st.toolPending = false; // v1.13.0 语义分段：当前是否处于工具执行区间
    st.toolStartT = 0;
    st.toolCalls = Object.create(null);
    st.toolMessageCalls = Object.create(null);
    st.finishedTools = Object.create(null);
    st.modelWaitMs = 0; st.toolResumeAt = 0;
    st.textSnapshots = Object.create(null);
    st.idleAccountedUntil = 0;
    st.prevEventAt = 0;
    st.evWin = [];          // v1.13.1：2s 内"单片 token 数"窗口（判批量冲刷）
    st.flushPeak = false;   // v1.13.1：本轮出现过被剔除的批量冲刷
    st.diagMax = null;      // v1.13.1 诊断：最大单片
    st.diagReplayEnd = "";  // v1.13.1 诊断：回放结束原因
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
    st.finalUsage = null; // 必须重置：否则本轮无 usage 事件时被上一轮的值污染
    st.lastResult = null;
    // v1.6.0：回放识别字段必须逐轮重置，否则一次中途接入会让该会话永久"接入态"
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
    st.lastSpeed = 0;        // v1.7.0
    st.replayEndSeen = false; // v1.7.0
    st.speedHist = [];        // v1.20.0 sparkline 逐轮重置
    st.lastSpeedSampleT = 0;
    // v1.8.0 计费渠道/收尾取证逐轮重置（否则上一轮的 provider 会在本轮 usage 到达前
    // 冒充本轮的渠道证据）
    st.providerUsage = "";
    st.endCause = "";
    st.errMsg = "";
    st.pendingError = "";
    st.userStopped = false;
    st.lastEventAt = now();
    var _boot = currentChannel("");   // 先用当前配置/记忆定个渠道（金额显示才不至于空一拍）
    st.channel = _boot.channel;
    st.channelSrc = _boot.src || "";
    st.provider = _boot.provider || (activeLlm && activeLlm.providerId) || "";
    refreshActiveLlm(false);          // 顺便刷新一次 /api/models/active（20s 内不重复请求）
    if (st.__sid === getSessionId()) {
      if (st.explicitReplay) renderReplay(st);
      else renderWaiting();
    }
  }

  // v1.14.0：原 closeSegForTool 与 endTurn/停顿补测里内联的"收段"代码统一为
  // closeCurrentSeg（见 02-state.js），语义一致：段末=最后 delta 时刻，空段不入列。

  function addDelta(text, st, evt) {
    if (!st || !text) return;
    // v1.8.0：有新内容说明流还活着 → 作废挂起的 error 帧（它不代表本轮真的死了）
    if (st.pendingError) { st.pendingError = ""; st.endCause = ""; }
    var t = st.eventAt || now();
    // The real protocol ends a message with delta:false full-text content. Keep
    // the incremental prefix per message/block so that terminal snapshots cannot
    // be counted a second time. Equal delta:true packets remain real output.
    var clean = text;
    var key = [evt && (evt.msg_id || evt.id) || "", evt && (evt.type || evt.object) || "text",
      evt && evt.index != null ? evt.index : 0].join("|");
    var prev = st.textSnapshots[key] || "";
    if (evt && evt.delta === false) {
      // Rewritten snapshots may adjust whitespace. Only the unobserved suffix
      // contributes to the estimate; snapshots are never decode-rate evidence.
      clean = text.slice(Math.min(prev.length, text.length));
      st.textSnapshots[key] = text;
      if (clean) st.snapshotFallback = true;
    } else st.textSnapshots[key] = prev + text;
    if (!clean) return;
    if (!st.tFirst) { st.tFirst = t; st.ttft = t - st.t0; }
    var deltaTok = estimateTokens(clean, st.model);
    if (st.explicitReplay && !st.replayDone) {
      st.replayTokens += deltaTok;
      st.replayLastT = t;
      renderReplay(st);
      return;
    }
    // v1.13.1 诊断：记下本轮"最大单片"（多少 tok / 多少字符 / 什么时候 / 当时处于哪个阶段）
    if (!st.diagMax || deltaTok > st.diagMax.tok) {
      st.diagMax = {
        tok: Math.round(deltaTok), chars: clean.length, at: Math.round(t - st.t0),
        phase: st.replayDone ? "live" : (st.attached ? "replay" : "probe")
      };
    }
    // v1.13.1：单片 token 窗口（判"批量冲刷"用；只在 live 段有效，回放/探测期无所谓）
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

    // ---- v1.6.0 中途接入回放识别 ----
    // 切换/中途打开对话时，QwenPaw 会把本轮已生成内容经同一 SSE 补发进来，
    // 速率远超物理解码上限（实测：回放 2222 tok/s 持续 24s，而 flash 解码上限
    // ~150）。照单全收会算出"纯生成 2258 tok/s"这类失真值 → 识别后剔除：
    // 回放 token 只记入 replayTokens，不进 tokenCount/segments/速度/峰值。
    // 真实爆发（如旗舰 3725 tok/s）只持续 1s 量级，不会误判：
    // 触发条件 = 单事件 >600 tok，或 3s 后 2s 窗速率仍 >800 tok/s，或累计 >20000
    if (!st.replayDone) {
      if (!st.attached) {
        if (!st.probeT0) st.probeT0 = t;
        st.probeTokens += deltaTok;
        pushWin(st.probeWin, t, st.probeTokens);
        var _age = t - st.probeT0;
        var _wr = 0;
        if (st.probeWin.length >= 2) {
          var _pdt = (t - st.probeWin[0][0]) / 1000;
          if (_pdt > 0.2) _wr = (st.probeTokens - st.probeWin[0][1]) / _pdt;
        }
        if (deltaTok > 600 || st.probeTokens > 20000 || (_wr > 800 && _age > 3000)) {
          // 判定为回放：本轮开头观测到的一切都是补发内容 → 探测期已计入统计的
          // tokenCount/分段/峰值整体作废（否则回放量会污染速度与峰值）
          st.attached = true;
          st.diagReplayEnd = "probe_flush"; // v1.13.1 诊断：探测期就认出是补发
          st.tokenCount = 0;
          st.estimatedTokens = 0;
          st.charCount = 0;
          st.eventCount = 0;
          st.peakMax = 0;
          st.peakRaw = 0;      // v1.14.1
          st.flushSkipped = 0; // v1.14.1
          st.window = [];
          st.segments = [];
          st.currentSeg = null;
          st.pauseMs = 0;
          st.liveTokens = 0;
          st.liveStartT = 0;
          st.toolCharCount = 0; st.toolEstTokens = 0; st.toolTokens = 0;
          st.toolPending = false; st.toolStartT = 0; st.toolCalls = Object.create(null);
          st.evWin = []; st.tLast = 0; st.idleAccountedUntil = 0;
          st.tFirst = t; st.ttft = 0; // 首字是回放首包，无意义；tFirst 仅作"已在生成"标志
          st.replayTokens = st.probeTokens; // 含本次 delta（下方直接 return，不会重复累加）
          st.replayLastT = t;
          st.replayWin = [[t, st.replayTokens]];
          renderReplay(st); // 悬浮条立刻切"回放中"，别让用户盯着 0 tok/s
          return;
        }
        if (_age > 6000 && _wr <= 800) {
          st.replayDone = true; // 前 6s 无回放特征 → 正常生成
          st.diagReplayEnd = "probe_normal"; // v1.13.1 诊断
        }
      }
      if (st.attached) {
        // 回放态：真静默 = 上一次**任意**事件（含工具帧/参数帧）也过了 >1.5s。
        // v1.13.1：旧版只看正文 delta（replayLastT），而补发的 agentic 历史里本来就有
        // 工具执行的间隔 → 一遇这种间隔就误判"补发结束"，把后面还在冲刷的补发当 live 计
        // （用户实测：live 1086 tok/s、峰值 12335.8 tok/s，而真正已生成只有 80.0k）
        var _silent = st.prevEventAt && t - st.prevEventAt > 1500;
        var _added = false;
        if (!_silent) {
          st.replayTokens += deltaTok; _added = true;
          st.replayLastT = t;
          pushWin(st.replayWin, t, st.replayTokens);
          if (st.replayWin.length >= 2) {
            var _rdt = (t - st.replayWin[0][0]) / 1000;
            // v1.13.1：证据窗口从 0.5s 收紧到 1.2s，防补发途中的慢段误判"已恢复生成"
            if (_rdt > 1.2 && (st.replayTokens - st.replayWin[0][1]) / _rdt < 500) {
              st.replayDone = true; // 速率降至物理解码水平 → live
              st.diagReplayEnd = "rate_low"; // v1.13.1 诊断
            }
          }
          if (!st.replayDone && t - st.t0 > 90000) {
            st.replayDone = true; // 兜底：回放态最长 90s
            st.diagReplayEnd = "cap90s";
          }
        } else if (deltaTok > 600) {
          // v1.13.1：静默后砸下来的是一大坨 → 还是补发的尾巴（网关/后端冲刷），不是真生成：
          // 真恢复生成的第一片正文不会一次 600+ tok。继续按回放剔除，别污染速度与峰值
          st.replayTokens += deltaTok; _added = true;
          st.replayLastT = t;
          pushWin(st.replayWin, t, st.replayTokens);
          st.diagFlushAfterSilent++;
        } else {
          st.replayDone = true; // 静默 >1.5s 且只是一小片正文 = 真的恢复生成了
          st.diagReplayEnd = "silent_small"; // v1.13.1 诊断
        }
        if (!st.replayDone) { renderReplay(st); return; } // 仍在回放：不进 tokenCount/分段/速度
        if (_added) { st.replayTokens -= deltaTok; st.replayWin.pop(); } // 本事件归 live，不重复计
        st.currentSeg = null; // live 分段从接入后重新计（回放窗口不并入第一段）
      }
    }

    // v1.13.0 语义分段：工具期结束后回来的第一片正文 = 新段起点。正常路径下
    // plugin_call_output 已把边界收好；这里兜住"边界帧缺失 / 参数帧后直接接正文"的流
    if (st.toolPending) {
      closeCurrentSeg(st, t);
      if (st.toolStartT) st.pauseMs += Math.max(0, t - st.toolStartT);
      st.toolPending = false;
      st.toolStartT = 0;
      st.toolCalls = Object.create(null);
      st.tLast = 0; st.idleAccountedUntil = 0;
    }
    if (st.toolResumeAt) {
      st.modelWaitMs += Math.max(0, t - st.toolResumeAt);
      st.toolResumeAt = 0;
    }

    // 静默等待按区间增量记账，轮询和新正文到达共用同一游标。
    if (st.tLast && t - st.tLast > 2000) {
      closeCurrentSeg(st);
      st.pauseMs += Math.max(0, t - Math.max(st.tLast, st.idleAccountedUntil || 0));
      st.idleAccountedUntil = t;
    }
    if (!st.currentSeg) {
      st.window = []; st.evWin = [[t, deltaTok, deltaTok > 600 && !!st.tLast && t - st.tLast >= 1200, st.tLast ? t - st.tLast : 0]]; st.lastSpeed = 0;
      st.currentSeg = { t0: t, t1: t, tokens: 0, firstTokens: deltaTok, flushTokens: 0, ev: 0, maxEv: 0 };
    }
    st.tLast = t;
    st.idleAccountedUntil = 0;
    if (!st.liveStartT) st.liveStartT = t;
    st.liveTokens += deltaTok;
    st.charCount += clean.length;
    st.estimatedTokens += rawEstimate(clean); // 仅 live 计入：回放不得污染 ratio 校准
    st.tokenCount += deltaTok; // 思考+正文都计入（与计费口径一致）
    if (st.currentSeg) {
      if (st.currentSeg.ev > 0 && st.currentSeg.t0 === t) st.currentSeg.firstTokens += deltaTok;
      if (st.currentSeg.ev > 0 && ((evt && evt.delta === false) || (st.evWin.length && st.evWin[st.evWin.length - 1][2]))) {
        st.currentSeg.flushTokens += deltaTok;
      }
      st.currentSeg.tokens += deltaTok;
      st.currentSeg.t1 = t;
      st.currentSeg.ev++; // v1.13.1 诊断
      if (deltaTok > st.currentSeg.maxEv) st.currentSeg.maxEv = deltaTok;
    }
    st.eventCount++;
    if (!evt || evt.delta !== false) tick(st);
    else if (st.__sid === getSessionId()) renderRunning(runningView(st));
  }

  function handleEvent(payload, st, receivedAt) {
    if (!st || !st.active) return;

    var evt = null;
    try { evt = JSON.parse(payload); } catch (e) { return; }
    if (!evt || typeof evt !== "object") return;
    st.eventAt = typeof receivedAt === "number" ? receivedAt : now();
    debugLogEvent(evt);
    var _prevAt = st.lastEventAt || 0; // v1.13.1：上一次任意事件时刻（回放期判"真静默"用）
    st.lastEventAt = st.eventAt;
    st.prevEventAt = _prevAt;

    if (!st.model) st.model = getCurrentModel();
    if (evt.model && typeof evt.model === "string") st.model = evt.model;
    if (evt.data && evt.data.model && typeof evt.data.model === "string") st.model = evt.data.model;

    // 用量事件：流进行中只记录、不覆盖 tokenCount（agentic 的 completion 可能是
    // 会话累计值）；最终在 endTurn 校准一次。
    var usage = extractUsage(evt);
    if (usage && usage.generated >= 0 && (!st.finalUsage || !st.finalUsage.exact || usage.exact)) {
      st.promptTokens = usage.promptTokens || 0;
      st.totalTokens = usage.total;
      if (typeof usage.cacheHit === "number") {
        st.cacheHitTokens = usage.cacheHit;
      }
      if (usage.model) st.model = usage.model;
      if (usage.provider) st.providerUsage = usage.provider; // v1.8.0 本回合真实渠道证据
      st.finalUsage = usage;
    }

    var type = evt.type || evt.event || "message";
    if (type !== "error" && /^(text|reasoning|data|plugin_call|plugin_call_output|turn_usage)$/.test(type)) {
      st.pendingError = "";
      if (st.endCause === "error_frame") st.endCause = "";
    }
    if (type === "error") {
      // v1.8.0：流内 error 帧不再当即判死。旧版直接 endTurn("error") → 生成中偶尔来
      // 一帧就被判"出错"（用户反馈"动不动莫名其妙出错"）。改成挂起 + 心跳延迟判定：
      // 1.6s 内还有新事件就当没发生，真没动静了才收尾（有输出按"已中断"计）
      var emsg = "";
      try {
        emsg = String((evt.data && (evt.data.message || evt.data.error)) || evt.message || evt.error || "流内 error 帧");
      } catch (e2) { emsg = "流内 error 帧"; }
      st.pendingError = emsg.slice(0, 80);
      st.endCause = "error_frame";
      warnOnce("errorframe", "SSE 出现 error 帧：" + st.pendingError + "（1.6s 内若还有新事件则忽略，不判出错）");
      return;
    }

    // v1.7.0：后端补发窗口结束的显式信号（前端 responseParser 同源处理
    // turn_usage / rate_limited）。已判中途接入时，有它就不用等 1.5s 静默启发式。
    // 尚未判接入时不关探测：本轮可能只是"补发量小、还没到判定阈值"，让探测继续跑
    // （后续若判回放，仍会把探测期整体作废；保守留着这条回溯能力）
    if (type === "replay_end" || type === "replayEnd") {
      st.replayEndSeen = true;
      st.replayDone = true;
      st.diagReplayEnd = "replay_end";
      if (st.attached) {
        st.currentSeg = null;
        st.window = []; st.evWin = []; st.lastSpeed = 0;
        st.toolPending = Object.keys(st.toolCalls).length > 0;
        st.toolStartT = st.toolPending ? st.eventAt : 0;
        st.toolResumeAt = 0;
        st.tLast = 0; st.idleAccountedUntil = 0;
        st.pauseMs = 0;
        st.liveStartT = 0;
      }
      return;
    }

    // Completed message envelopes contain the same delta:false content blocks
    // already observed through text/msg_id events (including reasoning).
    if (String(evt.status).toLowerCase() === "completed" && Array.isArray(evt.content)
        && (type === "reasoning" || type === "message")) {
      if (evt.role === "assistant" || !evt.role) {
        evt.content.forEach(function (block, index) {
          if (!block || typeof block.text !== "string" || !block.text) return;
          var id = block.msg_id || evt.id || evt.msg_id || "";
          var idx = block.index != null ? block.index : index;
          var kind = type === "reasoning" && st.textSnapshots[[id, "reasoning", idx].join("|")] != null ? "reasoning" : "text";
          addDelta(block.text, st, {type: kind, msg_id: id, index: idx, delta: false});
        });
        if (type !== "reasoning" && evt.id) st.messageId = evt.id;
      }
      return;
    }

    // reasoning：完全并入统计（建段、计速度、计峰值；v1.4.0 用户拍板，
    // 与计费口径一致且修正旧版 genSpeed 分子含思考分母不含的虚高）。
    // 兼容 evt.text 字符串与 evt.content 数组（DeepSeek）两形态
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

    // Tool request/output envelopes have DIFFERENT message IDs. Their data
    // frames carry the shared call_id; output in_progress is the execution START.
    if (type === "data" && evt.data) {
      var sharedCall = evt.data.call_id;
      var messageId = evt.msg_id || evt.id || "";
      if (sharedCall && messageId) {
        st.toolMessageCalls[messageId] = sharedCall;
        if (st.toolCalls[messageId]) {
          delete st.toolCalls[messageId]; st.toolCalls[sharedCall] = true;
        }
      }
      var boundCall = sharedCall || st.toolMessageCalls[messageId];
      if (boundCall && typeof evt.data.arguments === "string" && !st.toolPending) beginTool(st, boundCall, st.eventAt);
      if (boundCall && Object.prototype.hasOwnProperty.call(evt.data, "output")
          && String(evt.status).toLowerCase() === "completed") completeTool(st, boundCall, st.eventAt);
    }

    // v1.12.0：工具调用参数帧（普查实证外壳：type:"data" + delta:true +
    // data.call_id / data.name / data.arguments 分片）。后端 completion_tokens 含这块，
    // 单列统计（toolTokens），不进正文 tokenCount/分段/速度——口径 B：正文速度保持纯粹，
    // 总生成量另给合计。回放补发期（中途接入）的参数帧与正文一样剔除，不污染实时数。
    if (type === "data" && evt.delta === true && evt.data
        && typeof evt.data.arguments === "string" && evt.data.arguments) {
      var _arg = evt.data.arguments;
      st.toolCharCount += _arg.length;
      var _argTok = estimateTokens(_arg, st.model);
      st.toolEstTokens += _argTok;
      st.toolTokens += _argTok;
      if (st.attached && !st.replayDone) {
        st.replayToolTokens += _argTok;
        renderReplay(st);
        return;
      }
      var _argT = st.eventAt;
      if (!st.tFirst) { st.tFirst = _argT; st.ttft = _argT - st.t0; }
      if (!st.liveStartT) st.liveStartT = _argT;
      if (st.__sid === getSessionId()) renderRunning(runningView(st));
      return;
    }
    // plugin_call / plugin_call_output：工具起止边界帧（普查实证 1510 / 1495 次）。
    // v1.13.0：拿它们做语义分段——旧版靠 ">2s 静默" 猜段，而实测 62.5% 的工具循环
    // 静默 <2s（工具循环根本看不见），整轮被算成一段，分段/停顿/峰值全跟着失真
    if (type === "plugin_call" || type === "plugin_call_output") {
      var _bd = st.eventAt;
      st.lastEventAt = _bd;
      st.eventCount++;
      var callId = String(evt.call_id || (evt.data && evt.data.call_id) || st.toolMessageCalls[evt.id] || evt.id || "default");
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
    // 其余事件一律不当增量计数
  }

  // ════════════════════════════════════════════════════════════
  // 09-metrics.js · 实时指标：channelOf / runningView / tick / endTurn 收尾校准
  // ════════════════════════════════════════════════════════════
  // v1.8.0：本回合渠道——SSE usage 里的 provider（最准，中途才到）优先于配置渠道
  function channelOf(st) {
    if (st && st.providerUsage) {
      var ch = resolveChannel(st.providerUsage, providerBaseUrl(st.providerUsage));
      if (ch) return ch;
    }
    return (st && st.channel) || "";
  }

  // v1.20.0 燃烧率：按当前解码速度，每分钟烧掉多少（credits/min 或 ¥/h）。
  // 只算输出侧——输入是请求时一次性计费，不属于流式期间的"燃烧"。无价表 → null（不猜）。
  function burnRateOf(channel, model, speed, promptTok) {
    if (!(speed > 0)) return null;
    var ch = String(channel || "");
    if (ch === "tokenplan") {
      var e = tokenplanEntryFor(model);
      if (!e) return null;
      var tier = tpTier(e, promptTok || 0).tier;
      var f = tpFactor(e, Date.now()).factor;
      return { value: speed * tier.output / 10000 * 60 * f, unit: "credits/min" };
    }
    var outPrice = null;
    if (ch === "deepseek") {
      var t = priceTableFor(model);
      if (t) outPrice = ((isPeakHour(t) && t.peak) ? t.peak : t.offPeak).output;
    } else if (ch === "dashscope") {
      var de = tokenplanEntryFor(model);
      if (de) outPrice = tpTier(de, promptTok || 0).tier.output * ((de.bailianPeak && tpNightActive(Date.now())) ? de.night : 1);
    }
    if (outPrice == null) return null;
    return { value: speed * outPrice / 1e6 * 3600, unit: "¥/h" };
  }

  // v1.7.0：三处"生成中"渲染（tick / 停顿补测 / 会话切换刷新）共用同一份视图数据，
  // 避免口径各写一份漂移（旧版会话切换后的刷新会丢 attached 标记、速度显示 0）
  function observedWaitMs(st) {
    return st.pauseMs + (st.toolPending && st.toolStartT && !(st.attached && !st.replayDone)
      ? Math.max(0, now() - st.toolStartT) : 0);
  }
  function runningView(st, opts) {
    opts = opts || {};
    var _replay = st.attached ? (st.replayTokens || 0) : 0;
    var _tool = st.toolTokens || 0;
    var _costTok = st.tokenCount + _tool + _replay; // v1.12.0：实时金额含工具参数
    var _ch = channelOf(st);
    // v1.20.0：实时金额统一走 moneyFields（与 endTurn/liveSnapshot 同源，杜绝三处各写一份漂移）
    var _m = moneyFields(_ch, st.model, st.promptTokens, _costTok, st.cacheHitTokens);
    var _speed = (typeof opts.speed === "number") ? opts.speed : (st.lastSpeed || 0);
    return {
      ttft: st.attached ? 0 : st.ttft,
      speed: _speed,
      model: st.model,
      tokens: _costTok,     // 已生成 = 回放 + 接入后（总量口径，不含工具参数）
      toolTokens: _tool,                   // v1.12.0 工具参数单列
      attached: st.attached,
      replaying: st.attached && !st.replayDone,
      tokenSource: "estimate",
      outputTokens: _costTok,
      replayTokens: _replay,
      pauseSec: observedWaitMs(st) / 1000,
      modelWaitSec: (st.modelWaitMs + (st.toolResumeAt ? Math.max(0, now() - st.toolResumeAt) : 0)) / 1000,
      channel: _ch,
      cost: _m.cost,
      costUnit: _m.costUnit,
      afp: _m.afp,
      afpLo: _m.afpLo,
      afpHi: _m.afpHi,
      coefRange: _m.coefRange,
      // v1.20.0 TokenPlan 明细 / auto 区间 / 燃烧率（其他渠道 tp=null，UI 判空）
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
      var dt = (t - st.window[0][0]) / 1000;
      var dtok = st.tokenCount - st.window[0][1];
      if (dt > 0.1) speed = dtok / dt;
    }
    // v1.5.0：全程实时追踪峰值（旧实现 endTurn 从尾部 2s 窗口算，早期爆发全被丢）
    // v1.13.1：批量冲刷不入峰值——单片 >600 tok 且它贡献了窗口增长的一半以上，说明这一窗口
    // 是"一大坨一次性砸进来"（补发尾巴/网关缓冲刷出），不是模型解码速度：剔掉那一片后重算
    var _maxEv = 0;
    var _flushTok = 0;
    var _dtokW = 0, _dtW = 0;
    if (st.window.length >= 2) {
      _dtW = (t - st.window[0][0]) / 1000;
      _dtokW = st.tokenCount - st.window[0][1];
    }
    for (var _ei = 0; _ei < (st.evWin ? st.evWin.length : 0); _ei++) {
      var ev = st.evWin[_ei];
      if (ev[0] <= (st.window[0] ? st.window[0][0] : t)) continue;
      if (ev[1] > _maxEv) _maxEv = ev[1];
      // A buffered event remains excluded until it LEAVES the speed window.
      if (ev[2]) _flushTok += ev[1];
    }
    // v1.14.1：原始速度（不做任何剔除）单独留档——诊断与"峰值 ≥ 平均"兜底用
    if (speed > (st.peakRaw || 0)) st.peakRaw = speed;
    // v1.14.1：冲刷判定收紧——必须"静默之后砸下来"才算补发尾巴/网关缓冲刷出。
    // 旧版只看"单片 >600 tok 且贡献窗口增长过半"，而高分片模型（deepseek-v4.1-flash 等）
    // 正常流式本身就按大片推送，会被误剔 → 实测面板出现"平均 560.8 > 峰值 464.5"的自相矛盾。
    if (_flushTok > 0 && _dtW > 0.1) {
      st.flushPeak = true;
      speed = Math.max(0, (_dtokW - _flushTok) / _dtW);
    } else if (_maxEv > 600 && _dtW > 0.1 && _maxEv * 2 > _dtokW) {
      st.flushSkipped = (st.flushSkipped || 0) + 1;
    }
    if (speed > st.peakMax) st.peakMax = speed;
    st.lastSpeed = speed; // v1.7.0：详情面板实时刷新要显示这个速率
    // v1.20.0：sparkline 采样（≥200ms 一点，环形 120 点 ≈ 最近 24s+ 的速度轨迹）
    if (t - (st.lastSpeedSampleT || 0) >= 200) {
      st.lastSpeedSampleT = t;
      st.speedHist.push([t, speed]);
      if (st.speedHist.length > 120) st.speedHist.shift();
    }
    if (st.__sid === getSessionId()) {
      renderRunning(runningView(st));
    }
  }

  function endTurn(status, st, errMsg, endCause) {
    if (!st || !st.active) return;
    st.active = false;
    st.pendingError = "";
    st.lastTouched = Date.now();
    st.errMsg = String(errMsg || "").slice(0, 80);
    st.endCause = endCause || st.endCause || (status === DONE ? "stream_end" : "");
    if (!st.model) st.model = getCurrentModel(); // 兜底：全程无 model 事件且发送时 DOM 未读到
    if (!st.model) {
      // v1.5.0：会话级模型记忆——同一会话上一回合的模型大概率没变
      var _last = loadLastResult(st.__sid);
      if (_last && _last.model) st.model = _last.model;
    }
    // v1.8.0 计费渠道：usage.provider_id（本回合真值）→ /api/models/active（当前配置）
    // → 本会话上一回合的记忆 → 模型名兜底（只对 deepseek 名敢下结论）。全拿不到就留空：
    // 面板显示"渠道未识别"，宁可不出金额，也不再按模型名瞎猜出个错金额
    var _ch = currentChannel(st.providerUsage);
    if (!_ch.channel) {
      var _pr = loadLastResult(st.__sid);
      if (_pr && _pr.channel) _ch = { channel: _pr.channel, provider: _pr.provider || "", src: "memory" };
    }
    st.channel = _ch.channel;
    st.channelSrc = _ch.src || "";
    st.provider = _ch.provider || (activeLlm && activeLlm.providerId) || "";
    if (!st.channel) {
      warnOnce("channel", "拿不到计费渠道（usage.provider_id 为空且 /api/models/active 读不到）"
        + "→ 本轮只报 token，不显示套餐抵扣/费用。这是刻意的：按模型名猜会把官方按量算成套餐抵扣");
    }
    if (!st.model) warnOnce("model", "未能从 SSE / /api/models/active / DOM / 会话记忆读到模型名"
      + "（详情面板会显示\"模型未知\"）——QwenPaw 前端或接口可能已改版");
    refreshActiveLlm(false); // 顺手刷新一次渠道缓存（20s 内不重复请求）

    // 最终 usage 校准。防虚高 v4：
    // - 物理量级兜底：completion/耗时 > 2万 tok/s 非物理（脏 usage），token 与计费均回退估算
    // - 纯对话特征（无停顿且分段≤2）：估算不可靠，直接信精确 usage
    // - agentic 回合（有停顿/多段）：精确生成量远超流式估算（>×2.5+30）判定为
    //   会话累计值 → 显示保留估算，计费仍用精确值（真实消耗就是大）
    var looksCumulative = false; // true = 显示口径保留估算
    var implausible = false;     // true = usage 本身脏，计费也回退估算
    var usageOverwrite = false;  // v1.5.0：tokenCount 已被精确 usage 覆盖（分段需换算口径）
    if (st.finalUsage && st.finalUsage.generated >= 0) {
      var _gen = st.finalUsage.generated;
      st.totalTokens = st.finalUsage.total;
      st.totalGenerated = _gen; // v1.6.0：整轮真实生成量（中途接入时含回放部分）
      var elapsed0 = (now() - st.t0) / 1000;
      var pureChat = !st.attached && st.pauseMs < 2000 && st.segments.length <= 2;
      // v1.12.0：精确 completion 含工具参数，而 st.tokenCount 只含正文 → 比较与拆分
      // 都必须用"正文估算 + 工具估算"合计，否则重工具回合（工具约占输出 30%）会被
      // 误判成"会话累计值"，正文速度也会被工具 JSON 的字符量污染
      var _estText = st.tokenCount;        // 当前仍是正文估算（usageOverwrite 前）
      var _estTool = st.toolTokens;
      var _estAll = _estText + _estTool;
      if (st.attached) {
        // Calibrate all observed partitions together, preserving the replay/live
        // split. The old code allowed replay alone to exceed exact whole-turn use.
        var allObserved = _estAll + (st.replayTokens || 0);
        if (allObserved > 0) {
          var attachedScale = _gen / allObserved;
          st.tokenCount *= attachedScale;
          st.toolTokens *= attachedScale;
          st.replayTokens *= attachedScale;
          st.replayToolTokens *= attachedScale;
          usageOverwrite = true;
        }
      } else if (elapsed0 > 0.2 && _gen / elapsed0 > 20000) {
        implausible = true;
        looksCumulative = true;
      } else if (!st.finalUsage.exact && !pureChat && _gen > _estAll * 2.5 + 30) {
        looksCumulative = true;
      } else {
        // 精确 completion 按"正文估算 : 工具估算"拆成两份：正文进 tokenCount（参与
        // 分段/速度/峰值），工具进 toolTokens（单列）。两者之和 = 精确 completion
        if (_estAll > 0) {
          st.toolTokens = _gen * (_estTool / _estAll);
          st.tokenCount = _gen - st.toolTokens;
        } else {
          st.tokenCount = _gen; // 两侧估算都为 0（纯兜底）：整额给正文，行为同旧版
        }
        usageOverwrite = true;
      }
    }
    // v1.6.0：中途接入时 fullText 含回放内容，不能拿它回填 live 口径（否则速度被虚高）
    if (!usageOverwrite && !st.tokenCount && st.fullText && !st.attached) {
      st.tokenCount = estimateTokens(st.fullText, st.model);
    }
    // v1.13.0：回合在工具执行期收尾（打断/结束）时，把这段等待也记账，别摊进正文速度
    if (st.toolPending) {
      if (st.toolStartT) st.pauseMs += Math.max(0, now() - st.toolStartT);
      st.toolPending = false;
      st.toolStartT = 0;
    }
    if (st.toolResumeAt) {
      st.modelWaitMs += Math.max(0, now() - st.toolResumeAt);
      st.toolResumeAt = 0;
    }
    // 收尾当前段：段结束于最后一个 delta 时刻（速度不被停顿稀释）
    closeCurrentSeg(st);

    var elapsed = (now() - st.t0) / 1000;
    // 纯生成时间 = 各分段时长求和（剔除首字等待与工具等待）
    var genTime = 0;
    for (var si = 0; si < st.segments.length; si++) {
      genTime += Math.max(0, (st.segments[si].t1 - st.segments[si].t0) / 1000);
    }
    var genSpeed = 0;
    // v1.6.0：中途接入时平均速度的分母用"接入后时长"（t0 起算会把回放窗口算进去）
    var liveElapsed = (st.attached && st.liveStartT) ? (now() - st.liveStartT) / 1000 : elapsed;
    var avg = (st.attached ? liveElapsed : elapsed) > 0.1 ? st.tokenCount / (st.attached ? liveElapsed : elapsed) : 0;
    // v1.5.0：峰值 = tick() 全程实时追踪的 peakMax（旧实现从尾部 2s 窗口算，
    // 长回合早期爆发段全被丢：实测峰值 655.7 而第 1 段实际 3725）
    var peak = st.peakMax || 0;
    // v1.5.0 分段口径统一：usage 被采信时，分段 token 与峰值按 tokenCount/segSum
    // 比例换算到精确口径（钳制 0.2~5）——否则详情面板 chips（精确值）与分段表/
    // 折线图（估算值）两套数字打架（实测：分段和 22.8k vs 已生成 12.3k）
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
    // v1.5.0 保底：峰值 ≥ 折线图最高段速（同一换算口径），杜绝"图高于峰值"的观感矛盾
    var measuredTokens = 0;
    for (var si4 = 0; si4 < st.segments.length; si4++) {
      var sg = st.segments[si4];
      var dur = (sg.t1 - sg.t0) / 1000;
      if (dur > 0.05) {
        measuredTokens += measuredSegTokens(sg);
        var ss = measuredSegTokens(sg) / dur;
        if (ss > peak) peak = ss;
      }
    }
    genSpeed = genTime > 0.05 ? measuredTokens / genTime : 0;
    // Wall-clock throughput includes the first packet; measured window speed does
    // not. A large initial packet cannot establish a peak, so do not fabricate one.
    // v1.19.1：不变量兜底（展示自洽优先）——avg 为 wall-clock 口径（含首包等待），peak
    // 为 measured 窗口口径（不含首包，见上）。多窗口回合两口径可倒挂；此时取较大者，
    // 不展示"平均 > 峰值"的自相矛盾（v1.14.1 遗留未落地项，实测 560.8 > 464.5）。
    // 单包/无可测窗口回合不兜：一个瞬时大包不能建立峰值，保持 v1.15.0"不捏造"决策。
    if (measuredTokens > 0 && avg > peak) peak = avg;
    // 费用 output 侧优先精确 completion_tokens；usage 脏（非物理）时回退估算
    var costCompletion = (st.finalUsage && st.finalUsage.completionTokens >= 0 && !implausible)
      ? st.finalUsage.completionTokens : st.tokenCount + st.toolTokens + (st.replayTokens || 0);
    // v1.8.0：金额口径统一走 moneyFields（渠道决定套餐额度还是人民币，互斥）
    var _money = moneyFields(st.channel, st.model, st.promptTokens, costCompletion, st.cacheHitTokens);
    st.lastResult = {
      ts: Date.now(),
      ttft: st.attached ? 0 : st.ttft, // 中途接入的首字是回放首包，无意义
      tokens: st.tokenCount,
      outputTokens: costCompletion,
      tokenSource: st.finalUsage && !implausible ? "usage" : "estimate",
      messageId: st.messageId || "",
      originKnown: st.originKnown,
      snapshotFallback: st.snapshotFallback,
      toolTokens: st.toolTokens || 0, // v1.12.0 工具调用参数 token（单列，不进正文速度）
      total: st.totalTokens,
      seconds: elapsed,
      genTime: genTime,
      genSpeed: genSpeed,
      pauseSec: st.pauseMs / 1000,
      modelWaitSec: st.modelWaitMs / 1000,
      segments: st.segments.slice(-SEG_CAP), // 全量给详情面板（上限 200 段）
      cacheHit: st.cacheHitTokens || 0,
      cacheMiss: Math.max(0, (st.promptTokens || 0) - (st.cacheHitTokens || 0)),
      // v1.8.0：金额重算要输入/输出两侧的原始口径（渠道证据异步到手后要就地重算）
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
      // v1.11.0：路由别名（ark-code-latest）只给区间
      aliasModel: _money.aliasModel,
      afpLo: _money.afpLo,
      afpHi: _money.afpHi,
      coefRange: _money.coefRange,
      // v1.20.0 TokenPlan credits 三分量明细 / auto 参考区间（其他渠道为 null）
      tp: _money.tp,
      tpLo: _money.tpLo,
      tpHi: _money.tpHi,
      tpRange: _money.tpRange,
      errMsg: st.errMsg || "",
      endCause: st.endCause || "",
      model: st.model,
      avg: avg,
      peak: peak,
      flushPeak: !!st.flushPeak, // v1.13.1：峰值里剔除过批量冲刷
      peakRaw: st.peakRaw || 0,  // v1.14.1：未剔除冲刷的原始峰值（诊断）
      flushSkipped: st.flushSkipped || 0, // v1.14.1：疑似冲刷但按连续流保留的次数
      status: status,
      // v1.6.0 中途接入口径
      attached: st.attached,
      replayTokens: st.replayTokens,
      totalGenerated: st.totalGenerated || 0,
      liveTokens: st.tokenCount
    };
    // ratio 自校准（v1.5.0 按模型分表：强制思考模型的 completion/估算≈0.5 与
    // flash≈0.9 差一倍，全局单一 ratio 互相污染；防累计污染判定不变；钳制 0.2~5）
    if (usageOverwrite && !st.attached && !looksCumulative && st.estimatedTokens > 10 && st.tokenCount > 0) {
      var newRatio = st.tokenCount / st.estimatedTokens;
      if (newRatio > 0.2 && newRatio < 5) {
        calibrateRatio(String(st.model || "").toLowerCase(), newRatio);
      }
    }
    // v1.13.1 诊断：本轮"最大单片/回放结束原因/静默后又来大坨的次数/各段事件数"落 localStorage，
    // 下次再冒出莫名其妙的峰值，一看就知道是补发尾巴还是网关批量冲刷（不落任何正文）
    try {
      var _dseg = [];
      for (var _di = 0; _di < st.segments.length; _di++) {
        var _ds = st.segments[_di];
        _dseg.push({
          tok: Math.round(_ds.tokens), dur: +((_ds.t1 - _ds.t0) / 1000).toFixed(1),
          ev: _ds.ev || 0, maxEv: Math.round(_ds.maxEv || 0)
        });
      }
      localStorage.setItem("qp_token_speed_diag", JSON.stringify({
        ts: Date.now(), model: st.model, attached: !!st.attached, replayEnd: st.diagReplayEnd || "",
        replayTokens: Math.round(st.replayTokens || 0), liveTokens: Math.round(st.liveTokens || 0),
        tokens: Math.round(st.tokenCount || 0), toolTokens: Math.round(st.toolTokens || 0),
        peak: Math.round(peak), peakRaw: Math.round(st.peakRaw || 0),
        flushPeak: !!st.flushPeak, flushSkipped: st.flushSkipped || 0,
        flushAfterSilent: st.diagFlushAfterSilent || 0,
        maxDelta: st.diagMax, segs: _dseg
      }));
    } catch (e) { /* 诊断失败不影响统计 */ }
    // v1.9.0：页面刷新中止的回合不落库、不渲染（浏览器在卸载，别把上条好结果洗掉）
    if (st.endCause !== "page_refresh") {
      flushCensus();
      saveLastResult(st.__sid, st.lastResult); // 按流所属会话存
      appendLedger(st.__sid, st.lastResult);   // v1.20.0 会话账本（sid+messageId upsert，刷新恢复不重复计账）
      if (st.__sid === getSessionId()) renderDone(st.lastResult);
    }
    // 释放大字段
    st.fullText = ""; st.seenFullText = ""; st.window = []; st.segments = [];
    st.textSnapshots = Object.create(null); st.evWin = []; st.probeWin = []; st.replayWin = [];
    st.speedHist = []; // v1.20.0
  }

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

  // v1.15.0: reserve the stream epoch when a request is SENT, before response headers.
  // The observer reads a cloned response and always returns the original response unchanged.
  function patchFetch() {
    if (typeof window.fetch !== "function") return;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : String(input && input.url || input || "");
      var method = String(init && init.method || input && input.method || "GET").toUpperCase();
      var meta = {};
      try {
        var body = init && init.body;
        if (typeof body === "string") meta = JSON.parse(body) || {};
      } catch (e) { /* Request body parsing is optional; never affects the host request. */ }
      var sid = String(meta.chat_id || getSessionId());
      if (sid === "default" && meta.session_id) sid = String(meta.session_id);
      if (method === "POST" && /\/console\/chat\/stop(?:\?|$)/.test(url)) {
        try {
          var target = new URL(url, location.href || "http://localhost").searchParams.get("chat_id")
            || meta.chat_id || meta.session_id || sid;
          Object.keys(states).forEach(function (k) {
            var state = states[k];
            if (state && state.active && (k === target || state.requestSessionId === target)) {
              state.userStopped = true; state.endCause = "user_stop";
            }
          });
        } catch (eStop) { /* ignore */ }
        return origFetch.apply(this, arguments);
      }
      if (method !== "POST" || !/\/console\/chat(?:\?|$)/.test(url)) {
        var historyMatch = method === "GET" && /\/api\/chats\/([^/?]+)(?:\?|$)/.exec(url);
        if (historyMatch) {
          var historySid = decodeURIComponent(historyMatch[1]);
          var historyEpoch = states[historySid] ? states[historySid].epoch : 0;
          return origFetch.apply(this, arguments).then(function (response) {
            if (response && response.ok) {
              try {
                response.clone().json().then(function (data) {
                  if ((states[historySid] ? states[historySid].epoch : 0) === historyEpoch) hydrateChatHistory(historySid, data);
                }).catch(function () {});
              } catch (eHistory) { /* observer must not alter the response */ }
            }
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      }
      var startTime = now();
      var myState = getState(sid);
      var myEpoch = ++streamEpoch;
      startTurn(startTime, myState, myEpoch, {reconnect: meta.reconnect === true,
        fresh: meta.reconnect === false || Array.isArray(meta.input)});
      myState.requestSessionId = String(meta.session_id || "");
      pruneStates();
      // Read Request objects through a clone; the original body is never consumed.
      if (!(init && init.body) && input && typeof input.clone === "function") {
        try {
          input.clone().text().then(function (raw) {
            if (myState.epoch !== myEpoch) return;
            try { myState.requestSessionId = String(JSON.parse(raw).session_id || ""); } catch (eJSON) { /* ignore */ }
          }).catch(function () {});
        } catch (eBody) { /* ignore */ }
      }
      try { refreshActiveLlm(true); } catch (eRefresh) { /* ignore */ }
      var promise;
      try { promise = origFetch.apply(this, arguments); }
      catch (error) {
        finishAbnormal(myState, String(error.message || error), "read_error");
        throw error;
      }
      return promise.then(function (resp) {
        if (myState.epoch !== myEpoch) return resp;
        if (!resp || !resp.ok || !resp.body) {
          finishAbnormal(myState, "HTTP " + (resp && resp.status || "no response"), "http_error");
          return resp;
        }
        var ct = "";
        try { ct = String(resp.headers.get("content-type") || "").toLowerCase(); } catch (eHeaders) { /* ignore */ }
        if (ct && ct.indexOf("event-stream") < 0) {
          finishAbnormal(myState, "Response is not an event stream", "content_type");
          return resp;
        }
        try { monitorStream(resp.clone(), startTime, myState, myEpoch); }
        catch (eClone) { finishAbnormal(myState, "Stream observer unavailable", "observer_error"); }
        return resp;
      }, function (error) {
        if (myState.epoch === myEpoch) {
          finishAbnormal(myState, String(error && error.message || error),
            pageLeaving ? "page_refresh" : "read_error");
        }
        throw error;
      });
    };
  }

  function monitorStream(resp, t0, st, epoch) {
    var reader = resp.body.getReader();
    // v1.20.0 stability: even for stale/missing state we must cancel the clone we hold.
    // Response.clone() tees the stream: a branch never read AND never cancelled buffers
    // the entire response body in memory (leak on stop-and-resend / fast route switches).
    if (!st || st.epoch > epoch) {
      try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (e) { /* ignore */ }
      return;
    }
    if (st.epoch !== epoch || !st.active) startTurn(t0, st, epoch);
    var decoder = new TextDecoder();
    var buf = "", lines = [], eventType = "", ended = false, receivedAt = 0;
    function stale() { return st.epoch !== epoch; }
    function cancel() {
      try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (e) { /* ignore */ }
    }
    function dispatch() {
      if (!lines.length || stale() || ended) { lines = []; eventType = ""; return; }
      var payload = lines.join("\n"); lines = [];
      if (payload.trim() === "[DONE]") {
        ended = true; finishStream(st); eventType = ""; return;
      }
      // The event: field supplies the type when it is absent from the JSON envelope.
      try {
        if (eventType) {
          var obj = JSON.parse(payload);
          if (obj && typeof obj === "object" && !obj.type) { obj.type = eventType; payload = JSON.stringify(obj); }
        }
        handleEvent(payload, st, receivedAt);
      } catch (eEvent) {
        warnOnce("observer", "统计事件处理失败，已跳过；聊天流继续传递");
      }
      eventType = "";
    }
    function line(value) {
      if (value === "") { dispatch(); return; }
      if (value.charAt(0) === ":") return;
      var colon = value.indexOf(":");
      var field = colon < 0 ? value : value.slice(0, colon);
      var content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
      if (field === "data") lines.push(content);
      else if (field === "event") eventType = content;
    }
    function consume(final) {
      var match;
      while ((match = /[\r\n]/.exec(buf))) {
        var index = match.index;
        if (buf[index] === "\r" && index === buf.length - 1 && !final) break;
        var size = buf[index] === "\r" && buf[index + 1] === "\n" ? 2 : 1;
        var value = buf.slice(0, index); buf = buf.slice(index + size);
        line(value);
        if (stale() || ended) return;
      }
      if (final) { if (buf) line(buf); buf = ""; dispatch(); }
    }
    function pump() {
      reader.read().then(function (result) {
        if (stale() || ended) { cancel(); return; }
        if (result.done) {
          buf += decoder.decode(); consume(true);
          if (!ended) finishStream(st);
          try { reader.releaseLock(); } catch (eLock) { /* ignore */ }
          return;
        }
        receivedAt = now();
        buf += decoder.decode(result.value, {stream: true});
        // v1.20.0 stability: cap an unterminated SSE line at 4MB. A pathological gateway
        // must not grow the buffer without bound and drag the whole page down with it.
        if (buf.length > 4194304) {
          finishAbnormal(st, "SSE buffer overflow", "read_error");
          cancel(); return;
        }
        consume(false);
        if (stale() || ended) { cancel(); return; }
        pump();
      }).catch(function (error) {
        if (stale() || ended) return;
        finishAbnormal(st, String(error && (error.message || error.name) || "read error"), "read_error");
        try { reader.releaseLock(); } catch (eLock) { /* ignore */ }
      });
    }
    pump();
  }

  // 正常收尾（流读到 done）。v1.8.0：若期间挂起过 error 帧，按异常收尾
  function finishStream(st) {
    if (!st || !st.active) return;
    if (st.userStopped) { finishAbnormal(st, "", "user_stop"); return; }
    if (st.pendingError) { finishAbnormal(st, st.pendingError, "error_frame"); return; }
    endTurn(DONE, st, "", "stream_end");
  }

  // v1.8.0 异常收尾统一入口：有输出 → "已中断"；零输出 → 才叫"出错"
  // v1.9.0：页面刷新/关闭（pagehide 已触发）造成的零输出中止 → 也算"已中断（页面刷新）"，
  // 且不落库、不覆盖该会话上一条结果——那是导航掐死流，不是真失败
  function finishAbnormal(st, msg, cause) {
    if (!st || !st.active) return;
    var hasOutput = !!(st.tFirst || st.tokenCount > 0 || st.estimatedTokens > 0
      || st.charCount > 0 || st.toolTokens > 0 || (st.replayTokens || 0) > 0);
    if (!st.userStopped && st.__sid !== getSessionId()) {
      // QwenPaw aborts the viewing connection on route changes, while the agent
      // keeps generating. Keep in-memory observation for a later reconnect;
      // never overwrite the last completed result with a fictitious model abort.
      st.active = false; st.suspended = true; st.lastSpeed = 0;
      return;
    }
    var navAbort = pageLeaving && !hasOutput;
    var status = (st.userStopped || hasOutput || navAbort) ? "abort" : "error";
    var c = st.userStopped ? "user_stop" : (navAbort ? "page_refresh" : (cause || "read_error"));
    endTurn(status, st, msg, c);
  }

  // A run can finish while its viewing stream is disconnected. QwenPaw embeds
  // the final turn_usage in chat history metadata. Restore totals only; historical
  // text cannot establish decode timing, peaks, pauses or segment measurements.
  function hydrateChatHistory(sid, data) {
    if (!data || !Array.isArray(data.messages)) return;
    var state = states[sid];
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
      usage = extractUsage({type: "turn_usage", usage: snapshot.usage});
      if (usage) { message = candidate; break; }
    }
    if (!message || !usage) return;
    if (state) state.suspended = false;
    var previous = loadLastResult(sid);
    var meta = message.metadata || {};
    var end = Date.parse(meta.finished_at || meta.timestamp || "");
    // The history adapter regenerates display message IDs on every fetch. Use
    // the stable backend turn key or exact counts plus the backend finish time.
    var turnKey = meta.original_id || message.id;
    var sameMeasuredTurn = previous && !previous.historyOnly && previous.outputTokens === usage.generated
      && previous.total === usage.total && (previous.turnKey === turnKey || Math.abs(previous.ts - end) < 2000);
    if (sameMeasuredTurn) {
      previous.turnKey = turnKey;
      saveLastResult(sid, previous);
      return;
    }
    var startMeta = lastUser >= 0 ? messages[lastUser].metadata || {} : {};
    var start = Date.parse(startMeta.timestamp || "");
    if (previous && previous.messageId && end && previous.ts > end + 2000) return;
    var channel = currentChannel(usage.provider);
    var money = moneyFields(channel.channel, usage.model, usage.promptTokens, usage.generated, usage.cacheHit);
    var turnState = startMeta.metadata && startMeta.metadata.qwenpaw_turn_state;
    var aborted = /abort|cancel|stop/i.test(String(turnState && turnState.status || ""));
    var result = {
      ts: isFinite(end) ? end : Date.now(), messageId: message.id, turnKey: turnKey, historyOnly: true,
      tokenSource: "usage", outputTokens: usage.generated, tokens: usage.generated, toolTokens: 0,
      total: usage.total, promptTokens: usage.promptTokens, costTokens: usage.generated,
      cacheHit: usage.cacheHit, cacheMiss: Math.max(0, usage.promptTokens - usage.cacheHit),
      model: usage.model, provider: usage.provider, channel: channel.channel, channelSrc: "usage",
      cost: money.cost, costUnit: money.costUnit, afp: money.afp, coefMissing: money.coefMissing, priceMissing: money.priceMissing,
      aliasModel: money.aliasModel, coefRange: money.coefRange, afpLo: money.afpLo, afpHi: money.afpHi,
      tp: money.tp, tpLo: money.tpLo, tpHi: money.tpHi, tpRange: money.tpRange,
      status: aborted ? "abort" : DONE, endCause: aborted ? "user_stop" : "history", errMsg: "",
      ttft: 0, seconds: isFinite(start) && isFinite(end) && end >= start ? (end - start) / 1000 : 0,
      secondsKnown: isFinite(start) && isFinite(end) && end >= start,
      genTime: 0, genSpeed: 0, avg: 0, peak: 0, pauseSec: 0, segments: [],
      attached: false, replayTokens: 0, totalGenerated: usage.generated, liveTokens: 0
    };
    saveLastResult(sid, result);
    appendLedger(sid, result); // v1.20.0: history-restored turns enter the ledger too (turnKey upsert, no double count)
    if (sid === getSessionId()) { refreshBarContent(); refreshDetail(result); }
  }

  // v1.8.0：渠道证据是异步到的（/api/models/active、/api/models）。证据到手后把
  // 正在跑的回合与"当前会话最后一条结果"就地重算一遍金额，避免用户看到空着或写错的
  // 金额（v1.7 老结果没有 channelSrc，rank=0，会被更强证据修正掉——用户这次看到的
  // 错金额就属于这一类）
  function channelRank(src) {
    if (src === "usage") return 3;
    if (src === "active") return 2;
    if (src === "model" || src === "memory") return 1;
    return 0;
  }
  function applyBillingRetro(force) {
    try {
      var cur = currentChannel(""); // 当前配置证据（单回合的 usage 证据只有该回合自己有）
      Object.keys(states).forEach(function (sid) {
        var st = states[sid];
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
      // Re-price a known historical provider using that provider's own evidence.
      // A current settings change must not turn an unrelated vendor into AFP or
      // DeepSeek just because the historical channel was previously unknown.
      if (r.provider) {
        cur = {channel: resolveChannel(r.provider, providerBaseUrl(r.provider)), provider: r.provider,
          src: r.channelSrc === "usage" ? "usage" : "memory"};
      }
      if (!cur.channel) return;
      var stronger = channelRank(cur.src) > channelRank(r.channelSrc);
      // force：providerMap（base_url 证据）刚到位时允许升级，但只允许从"其他渠道/未识别"
      // 升上来（评审 P1-5 证据击穿：旧版 force 能覆盖任何渠道，切渠道后会把 usage 实证过
      // 的历史结果重算一遍，金额被凭空改写）
      var upgraded = !!force && (!r.channel || r.channel === "other") && cur.channel !== r.channel;
      if (!stronger && !upgraded) return;
      var pt = r.promptTokens != null ? r.promptTokens : ((r.cacheHit || 0) + (r.cacheMiss || 0));
      var ct = r.costTokens != null ? r.costTokens : r.tokens;
      var money = moneyFields(cur.channel, r.model, pt, ct, r.cacheHit || 0);
      // v1.20.0: credits breakdown / discount / auto-range participate in the change signature too
      function tpSig(x) { return x.tp ? (x.tp.credits + ":" + x.tp.factor) : (x.tpRange ? ("r:" + x.tpLo + ":" + x.tpHi) : "n"); }
      var before = [r.cost == null ? "n" : r.cost, r.afp == null ? "n" : r.afp, r.channel || "",
        r.afpLo == null ? "n" : r.afpLo, r.afpHi == null ? "n" : r.afpHi, tpSig(r)].join("|");
      var after = [money.cost == null ? "n" : money.cost, money.afp == null ? "n" : money.afp, money.channel,
        money.afpLo == null ? "n" : money.afpLo, money.afpHi == null ? "n" : money.afpHi, tpSig(money)].join("|");
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
      r.tp = money.tp; r.tpLo = money.tpLo; r.tpHi = money.tpHi; r.tpRange = money.tpRange;
      saveLastResult(sid2, r);
      appendLedger(sid2, r); // v1.20.0: keep the ledger amount in sync after retroactive re-pricing
      refreshBarContent();
      refreshDetail(r);
    } catch (e) { /* 金额补算失败不影响统计 */ }
  }

  // Token Speed 1.20 · Instrument Deck visual system
  // 设计语言：炭黑玻璃底 + 三色语义（薄荷=速度 / 金=Credits / 蓝=输出），
  // 悬浮条是仪表条，面板是飞行数据读数。所有颜色走 CSS 变量，dream-skin 磨砂兼容块原样保留。
  var styles = `
    #qp-token-speed-bar, #qp-token-speed-detail {
      --qp-bg: rgba(16,22,31,.96); --qp-panel: #131b26; --qp-ink: #eef3fa; --qp-mut: #8b99ad;
      --qp-mint: #7fe7c4; --qp-blue: #8fb8ff; --qp-gold: #ffd479; --qp-warn: #f6ce9e; --qp-err: #ff9d9d;
      --qp-line: #ffffff14;
      box-sizing:border-box; font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; font-variant-numeric:tabular-nums; color:var(--qp-ink); line-height:1.5;
    }
    /* ── 悬浮条：仪表条 ── */
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
    /* ── 详情面板：飞行数据读数 ── */
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
    /* hero 三卡：速度 / 输出 / 计费 */
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
    /* 时间带 */
    #qp-token-speed-detail .qp-d-timings { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid #ffffff12; border-radius:13px; padding:13px 0; margin-bottom:18px; background:#0c142320; }
    #qp-token-speed-detail .qp-d-time { padding:0 14px; border-left:1px solid #ffffff10; }
    #qp-token-speed-detail .qp-d-time:first-child { border-left:0; }
    #qp-token-speed-detail .qp-d-time span { display:block; color:#99abc4; font-size:11px; }
    #qp-token-speed-detail .qp-d-time strong { display:block; margin-top:5px; font-size:17px; font-weight:550; color:#e3ecfb; }
    /* 章节与用量网格 */
    #qp-token-speed-detail .qp-d-section { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 10px; font-size:12px; font-weight:600; color:#d8e4f7; }
    #qp-token-speed-detail .qp-d-section small { font-size:10px; color:#859ab8; font-weight:400; }
    #qp-token-speed-detail .qp-d-usage { display:grid; grid-template-columns:1fr 1fr; gap:0 26px; padding:2px 0 14px; }
    #qp-token-speed-detail .qp-c { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:7px 0; min-width:0; }
    #qp-token-speed-detail .qp-cl { color:#98abc5; font-size:12px; }
    #qp-token-speed-detail .qp-cv { text-align:right; color:#e0eafd; font-size:12px; overflow-wrap:anywhere; }
    /* Credits 三分量条 */
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
    /* 今日账本 */
    #qp-token-speed-detail .qp-lg { padding:2px 0 14px; }
    #qp-token-speed-detail .qp-lg-sum { display:flex; flex-wrap:wrap; gap:6px 14px; color:#c3d0e4; font-size:12px; }
    #qp-token-speed-detail .qp-lg-cr { color:var(--qp-gold); font-weight:600; }
    #qp-token-speed-detail .qp-lg-cny { color:#a8ecd9; font-weight:600; }
    #qp-token-speed-detail .qp-lg-plan { color:var(--qp-blue); font-weight:600; }
    #qp-token-speed-detail .qp-lg-amort { color:#98a9c1; }
    #qp-token-speed-detail .qp-lg-models { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    #qp-token-speed-detail .qp-lg-m { padding:2px 8px; border:1px solid var(--qp-line); border-radius:7px; color:#9fb0c8; font-size:11px; background:#ffffff05; }
    #qp-token-speed-detail .qp-tp-select { margin-left:auto; padding:2px 6px; border-radius:6px; border:1px solid #ffd47930; background:#1a2230; color:var(--qp-gold); font-size:11px; cursor:pointer; }
    /* 说明 / 图表 / 分段表 */
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
    /* 代码块整体透明磨砂化，与聊天气泡风格统一（dream-skin 兼容） */
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

  // ════════════════════════════════════════════════════════════
  // 13-ui-bar.js · 悬浮条渲染（等待/生成中/回放/结果四态）+ 渠道文案
  // v1.20.0 仪表化重设计：状态·模型·速度·输出·费用 chip·详情，一眼读完本轮经济账
  // ════════════════════════════════════════════════════════════
  // ---------- 渲染（bar：实时态/完成态/空态） ----------

  // v1.7.0：中途接入口径说明只留在 hover title 里；条上与面板上的正文一律压到最短
  // （用户反馈：那段长说明太占地方，正文本该是给你的眼，细节想要时再 hover）
  var ATTACH_TIP = "中途接入：切到会话时后端补发的历史生成内容，其速率无参考价值，"
    + "已从速度 / 峰值 / 分段中剔除；回放量仍计入总量与费用";

  function buildWaitingHtml() {
    return barState("连接中") + '<span class="qp-ts-label">等待首字到达…</span>';
  }

  // v1.8.0：渠道文案（面板 chip + hover 说明），正文一律说人话；v1.19.0：代号 plan（旧值 afp 兼容显示）
  // v1.20.0：新增百炼 Token Plan / 百炼按量
  function channelLabel(ch) {
    if (ch === "plan" || ch === "afp") return "套餐渠道";
    if (ch === "coding") return "Coding Plan";
    if (ch === "deepseek") return "DeepSeek 官方";
    if (ch === "tokenplan") return "百炼 Token Plan";
    if (ch === "dashscope") return "百炼按量";
    if (ch === "other") return "其他渠道";
    return "未识别";
  }
  function channelTip(ch, provider) {
    var head = "计费渠道：" + channelLabel(ch) + (provider ? "（" + provider + "）" : "") + "。";
    if (ch === "plan" || ch === "afp") return head + "走套餐（Agent Plan）渠道，按套餐额度抵扣——同一个模型名在按量渠道是人民币计费，两边计费方式互斥，所以只能按渠道判";
    if (ch === "coding") return head + "走 Coding Plan 渠道（地址 /api/coding/v3 或 coding.dashscope.aliyuncs.com），按请求次数计、不是 token/额度，个人版无公开用量 API → 本插件只报 token，不报金额";
    if (ch === "deepseek") return head + "走 DeepSeek 官方 API，按人民币计价（尖峰/低谷单价不同）";
    if (ch === "tokenplan") return head + "走阿里云百炼 Token Plan，按 Credits 抵扣：credits/万tok 的数值 = 官方刊例价 元/百万tok（1 credit = 0.01 元刊例价）。北京时间 22:00–08:00 部分模型享官方夜间折扣（qwen3.8 系 4 折 / deepseek-v4 系 5 折），qwen4-max-preview 预览期另有 2 折；plus/flash 系按输入 token 阶梯计价";
    if (ch === "dashscope") return head + "走阿里云百炼按量付费，人民币刊例价计价（DeepSeek 系模型分忙/闲时，忙 08:00–22:00 北京）；与 Token Plan 的 Credits 额度相互独立、不互通";
    if (ch === "other") return head + "不是套餐/DeepSeek 官方这类内置价目渠道，本插件没有该渠道价表 → 只报 token，不报金额（可在覆盖层配 generic 价目）";
    return head + "拿不到 provider 信息（usage.provider_id 为空、/api/models/active 也读不到）→ 只报 token，不报金额。宁可空着，也不按模型名猜一个错数";
  }

  // v1.8.0：状态文案 + hover 说明（过去"莫名其妙的出错"就是这里看不见原因）
  function statusInfo(r, running) {
    if (running) return { text: "生成中", tip: "正在生成，面板每 600ms 就地刷新" };
    if (r && r.status === DONE) {
      if (r.historyOnly) return { text: "历史用量", tip: "从后端聊天记录恢复精确本轮用量；未观测到的速度、峰值和分段不推算" };
      return { text: "完成", tip: r.endCause === "error_frame" ? "流正常结束（期间出现过 error 帧，但之后仍在产出）" : "流正常结束" };
    }
    if (r && r.status === "abort") {
      var t = r.endCause === "user_stop" ? "你点了停止"
        : r.endCause === "page_refresh" ? "页面刷新/关闭，本轮生成被中止（零产出，未计入）"
        : r.endCause === "error_frame" ? "流内 error 帧之后不再有内容"
        : "流被中断（切会话 / 刷新页面 / 网络断开）";
      return { text: "已中断", tip: t + (r.errMsg ? "：" + r.errMsg : "") };
    }
    return {
      text: "出错",
      tip: "一个 token 都没产出来就失败了" + (r && r.errMsg ? "：" + r.errMsg : "")
        + (r && r.endCause ? "（" + r.endCause + "）" : "")
    };
  }

  function barItem(label, value, cls, tip) {
    return '<span class="qp-ts-item ' + (cls || '') + '"' + (tip ? ' title="' + escHtml(tip) + '"' : '') + '><span class="qp-ts-label">' + label + '</span><span class="qp-ts-val">' + value + '</span></span>';
  }
  function barState(text, tip) {
    return '<span class="qp-ts-state" title="' + escHtml(tip || '') + '"><span class="qp-ts-dot"></span>' + text + '</span>';
  }
  // v1.20.0 费用 chip：credits 金色 ◈ / 人民币 ¥ / 套餐 ▣。算不出钱就不显示（宁可空着不猜）。
  // 符号 + 数值即可，单位与口径放 hover——条上空间留给速度。
  function costChipHtml(r) {
    if (!r) return "";
    if (r.cost != null && r.costUnit === "credits") {
      return '<span class="qp-ts-item qp-ts-cost credits" title="本轮 Credits 消耗（百炼 Token Plan）≈' + escHtml(fmtMoney(creditsToCny(r.cost), "¥")) + ' 刊例价"><span class="qp-ts-val">◈ ' + fmtCredits(r.cost) + '</span></span>';
    }
    if (r.cost != null && r.costUnit === "plan") {
      return '<span class="qp-ts-item qp-ts-cost plan" title="套餐抵扣 ' + escHtml(fmtMoney(r.cost, "")) + ' 额度"><span class="qp-ts-val">▣ ' + fmtMoney(r.cost, "") + '</span></span>';
    }
    if (r.cost != null) {
      return '<span class="qp-ts-item qp-ts-cost cny" title="本轮费用（人民币）"><span class="qp-ts-val">' + fmtMoney(r.cost, "¥") + '</span></span>';
    }
    if (r.afp != null && r.afp > 0) {
      return '<span class="qp-ts-item qp-ts-cost plan" title="套餐抵扣 ' + escHtml(fmtPlan(r.afp)) + ' 额度"><span class="qp-ts-val">▣ ' + fmtPlan(r.afp) + '</span></span>';
    }
    if (r.coefRange && r.afpLo != null) {
      return '<span class="qp-ts-item qp-ts-cost plan" title="Auto 路由活动期外：套餐抵扣参考区间"><span class="qp-ts-val">▣ ' + fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }) + '</span></span>';
    }
    if (r.tpRange && r.tpLo != null) {
      return '<span class="qp-ts-item qp-ts-cost credits" title="auto 路由：全表当前时刻 Credits 参考区间"><span class="qp-ts-val">◈ ' + fmtCredits(r.tpLo) + '~' + fmtCredits(r.tpHi) + '</span></span>';
    }
    return "";
  }
  // v1.20.0 模型名短标（截断由 CSS 负责，hover 看全名）
  function barModelHtml(model) {
    if (!model) return "";
    return '<span class="qp-ts-model" title="' + escHtml(model) + '">' + escHtml(model) + '</span>';
  }
  function buildRunningHtml(x) {
    if (x.replaying) return barState("回放中", ATTACH_TIP) + barItem("已恢复", fmtNum(x.replayTokens || 0) + " tok") + '<span class="qp-ts-more">详情 ↗</span>';
    return barState(x.attached ? "已接入" : "生成中", x.attached ? ATTACH_TIP + "；回放 " + fmtNum(x.replayTokens || 0) + " tok" : "实时估算，结束后由后端用量校准") +
      barModelHtml(x.model) +
      barItem("速度", fmtSpeed(x.speed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed") +
      barItem("输出", (x.tokenSource === "estimate" ? "≈" : "") + fmtNum(x.tokens) + '<small class="qp-ts-unit">tok</small>') +
      (x.pauseSec > .5 ? barItem("等待", fmtSec(x.pauseSec), "qp-ts-extra") : !x.attached ? barItem("首字", fmtMs(x.ttft), "qp-ts-extra") : '') +
      costChipHtml(x) +
      '<span class="qp-ts-more">详情 ↗</span>';
  }
  function buildResultHtml(r) {
    var info = statusInfo(r, false);
    var total = r.outputTokens != null ? r.outputTokens : r.attached && r.totalGenerated ? r.totalGenerated : (r.tokens || 0) + (r.toolTokens || 0);
    var html = barState(r.attached ? "已接入" : info.text, info.tip + (r.attached ? "；" + ATTACH_TIP + "；回放 " + fmtNum(r.replayTokens || 0) + " tok" : ""));
    html += barModelHtml(r.model);
    if (r.genSpeed > 0 && !r.historyOnly) html += barItem("生成", fmtSpeed(r.genSpeed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed");
    html += barItem("输出", (r.tokenSource === "estimate" ? "≈" : "") + fmtNum(total) + '<small class="qp-ts-unit">tok</small>', '', "本轮输出总量，含正文、思考和工具参数");
    if (r.secondsKnown !== false && r.seconds != null) html += barItem(r.originKnown === false ? "观察" : "耗时", fmtSec(r.seconds), "qp-ts-extra");
    html += costChipHtml(r);
    return html + '<span class="qp-ts-more">详情 ↗</span>';
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
  // v1.6.0 回放态渲染（回放期间 addDelta 直接 return，不会走到 tick，故单独入口）
  function renderReplay(st) {
    if (st.__sid !== getSessionId()) return;
    var t = now();
    if (t - lastRunRender < RENDER_MIN_GAP) return;
    lastRunRender = t;
    setBar("running", buildRunningHtml({
      replaying: true, attached: true,
      ttft: 0, speed: 0, tokens: st.replayTokens,
      replayTokens: st.replayTokens, pauseSec: st.pauseMs / 1000
    }));
  }

  function renderDone(r) {
    setBar(r.status === DONE ? "done" : r.status, buildResultHtml(r));
    // v1.7.0：面板开着就地把内容刷成终态（不再重建元素 → 不闪、不丢滚动位置）
    refreshDetail(r);
  }
  function renderWaiting() {
    setBar("running", buildWaitingHtml());
  }

  // ════════════════════════════════════════════════════════════
  // 14-ui-panel.js · 详情面板（三卡 hero / sparkline / Credits 分解 / 今日账本 / 分段增量表）
  // v1.20.0 仪表甲板重设计：head 每拍重绘（数字实时跳），分段表增量追加（滚动不丢）
  // ════════════════════════════════════════════════════════════
  // ---------- 详情面板（独立界面：大折线图 + 分段明细 + 完整汇总） ----------

  // v1.14.1：平均口径说明（平均含首字与工具等待，正常必然低于峰值；若出现"平均 > 峰值"，
  // 说明峰值被剔除逻辑或采样偏差吃掉——面板已改为取二者较大值兜底，此处留作排查线索）
  var AVG_TIP = "平均 = 正文与思考 token ÷ 观察时长（含首字和工具等待）；工具参数包含在输出总量中，但不计入此速度。"
    + "流式速度由字符估算，后端用量到达后按比例校准，属于观测速率。中途接入仅计接入后的速度。";

  function segSpeed(s) {
    var dt = (s.t1 - s.t0) / 1000;
    return dt > 0.05 ? measuredSegTokens(s) / dt : 0;
  }

  // 大号分段速度折线图（SVG 560×176，带 Y 轴刻度与悬浮提示）
  function buildDetailChart(segs) {
    var sourceIndices = [];
    segs = (segs || []).filter(function (segment, index) {
      var valid = segment.t1 - segment.t0 > 50 && measuredSegTokens(segment) > 0;
      if (valid) sourceIndices.push(index + 1);
      return valid;
    });
    if (!segs || segs.length < 2) {
      return '<div class="qp-d-empty">可测速分段不足 · 需要 2 段有效包间样本才绘制趋势；单包与过短分段不推算速度。</div>';
    }
    var W = 560, H = 176, PL = 46, PR = 18, PT = 18, PB = 28;
    var speeds = segs.map(segSpeed);
    var max = Math.max.apply(null, speeds.concat([1]));
    var n = segs.length;
    function x(i) { return PL + (n === 1 ? 0 : i * (W - PL - PR) / (n - 1)); }
    function y(v) { return H - PB - (v / max) * (H - PT - PB); }
    var pts = speeds.map(function (v, i) { return [x(i), y(v)]; });
    var path = pts.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    // Y 轴网格与刻度（0 / max/2 / max）
    var grid = "";
    [0, 0.5, 1].forEach(function (f) {
      var gy = y(max * f).toFixed(1);
      var label = (max * f).toFixed(max >= 100 ? 0 : 1);
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
        '<text x="' + (PL - 6) + '" y="' + gy + '" fill="#7d8ca3" font-size="10" text-anchor="end" dominant-baseline="middle">' + label + "</text>";
    });
    // X 轴段号（首、尾，段多时加中点）
    var axis = '<text x="' + x(0) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[0] + '</text>' +
      '<text x="' + x(n - 1) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[n - 1] + "</text>";
    if (n >= 6) {
      var mid = Math.floor((n - 1) / 2);
      axis += '<text x="' + x(mid) + '" y="' + (H - 8) + '" fill="#7d8ca3" font-size="10" text-anchor="middle">' + sourceIndices[mid] + "</text>";
    }
    // 折线 + 每段数据点（悬浮 title 提示该段明细）
    var dots = pts.map(function (p, i) {
      var s = segs[i];
      var tip = "段" + sourceIndices[i] + "：总量 " + Math.round(s.tokens) + " tok；测速增量 " + Math.round(measuredSegTokens(s))
        + " tok / " + ((s.t1 - s.t0) / 1000).toFixed(1) + "s = " + speeds[i].toFixed(1) + " tok/s（排除首包和缓冲冲刷）";
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (i === n - 1 ? 3.5 : 2.5) +
        '" fill="' + (i === n - 1 ? "#ffd479" : "rgba(127,231,196,0.85)") + '"><title>' + tip + "</title></circle>";
    }).join("");
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="各有效分段生成速度趋势，单位 tok/s">' + grid +
      '<path d="' + path + '" stroke="rgba(143,184,255,0.75)" stroke-width="1.5" fill="none"/>' + dots + axis + "</svg>";
  }

  // v1.20.0 实时速度 sparkline（生成中 hero 速度卡内；≥2 个采样点才画，不捏造趋势）
  function buildSparkline(hist) {
    if (!hist || hist.length < 2) return "";
    var W = 220, H = 40, max = 1, i;
    for (i = 0; i < hist.length; i++) if (hist[i][1] > max) max = hist[i][1];
    var t0 = hist[0][0], span = Math.max(1, hist[hist.length - 1][0] - t0);
    var pts = hist.map(function (p) { return [(p[0] - t0) / span * W, H - 4 - (p[1] / max) * (H - 10)]; });
    var d = pts.map(function (p, j) { return (j ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    return '<svg class="qp-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + d + ' L' + W + ',' + H + ' L0,' + H + ' Z" fill="rgba(127,231,196,0.10)"/>' +
      '<path d="' + d + '" fill="none" stroke="#7fe7c4" stroke-width="1.5"/></svg>';
  }

  // v1.20.0 计费 hero 卡：credits 金 / 人民币青 / 套餐蓝；算不出钱给"—"与原因（不猜）
  function billingCardHtml(r) {
    var label, num, cap, cls = "";
    if (r.cost != null && r.costUnit === "credits") {
      cls = " credits";
      label = 'Credits 消耗<span class="qp-d-tag">Token Plan</span>';
      num = fmtCredits(r.cost) + '<small>credits</small>';
      cap = '≈' + fmtMoney(creditsToCny(r.cost), '¥') + ' 刊例价';
      var tierId = tpTierPref(), plan = null;
      for (var i = 0; i < TP_PLANS.length; i++) if (TP_PLANS[i].id === tierId) plan = TP_PLANS[i];
      if (plan) cap += ' · 按 ' + plan.name + ' 摊销 ≈' + fmtMoney(r.cost * plan.price / plan.quota, '¥');
      if (r.tp && r.tp.factor < 1) cap = '<span class="qp-d-disc">' + escHtml(r.tp.factorNote || '折扣生效') + '</span>' + cap;
    } else if (r.cost != null && r.costUnit === "plan") {
      label = '套餐抵扣';
      num = fmtMoney(r.cost, "") + '<small>额度</small>';
      cap = escHtml(channelLabel(r.channel));
    } else if (r.cost != null) {
      label = '本轮费用';
      num = fmtMoney(r.cost, '¥');
      cap = escHtml(channelLabel(r.channel));
      if (r.channel === "deepseek") {
        var t = priceTableFor(r.model);
        if (t) cap += ' · ' + (isPeakHour(t) ? '尖峰时段' : '低谷时段');
      }
    } else if (r.afp != null && r.afp > 0) {
      label = '套餐抵扣';
      num = fmtPlan(r.afp) + '<small>额度</small>';
      cap = '系数计费 · ' + escHtml(channelLabel(r.channel));
    } else if (r.coefRange && r.afpLo != null) {
      label = '套餐抵扣 · 参考';
      num = fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }) + '<small>额度</small>';
      cap = 'Auto 路由 · 活动期外参考区间';
    } else if (r.tpRange && r.tpLo != null) {
      cls = " credits";
      label = 'Credits · 参考';
      num = fmtCredits(r.tpLo) + '~' + fmtCredits(r.tpHi) + '<small>credits</small>';
      cap = 'auto 路由 · 全表当前时刻区间';
    } else {
      label = '计费';
      num = '—';
      cap = r.coefMissing ? '系数未知' : r.priceMissing ? '无价表' : '渠道未识别';
    }
    return '<div class="qp-d-card bill' + cls + '"><div class="qp-d-label">' + label + '</div><div class="qp-d-number">' + num + '</div><div class="qp-d-caption">' + cap + '</div></div>';
  }

  // v1.20.0 Credits 三分量分解条（输入/缓存/输出），阶梯/估算/折扣口径全部标注
  function tpBreakdownHtml(r) {
    if (!r.tp) return "";
    var t = r.tp, sum = Math.max(t.input + t.cache + t.output, 1e-9);
    function bar(label, v, cls) {
      var pct = Math.max(2, Math.round(v / sum * 100));
      return '<div class="qp-tp-row"><span class="qp-tp-l">' + label + '</span><span class="qp-tp-track"><span class="qp-tp-fill ' + cls + '" style="width:' + pct + '%"></span></span><span class="qp-tp-v">' + fmtCredits(v) + '</span></div>';
    }
    var notes = [];
    if (t.tierIdx > 0) notes.push('输入超阶梯阈值，按第 ' + (t.tierIdx + 1) + ' 档计价');
    if (t.cacheAssumed) notes.push('缓存命中单价未公布，按输入价估算');
    if (t.assumedBase) notes.push('预览版无独立刊例价，按 qwen4-max 刊例价估算');
    return '<div class="qp-d-section">Credits 构成<small>输入 / 缓存 / 输出 · 三分量</small></div><div class="qp-tp">' +
      bar('输入', t.input, 'in') + bar('缓存', t.cache, 'ca') + bar('输出', t.output, 'out') +
      (notes.length ? '<div class="qp-tp-note">' + escHtml(notes.join('；')) + '</div>' : '') + '</div>';
  }

  // v1.20.0 今日账本（本地滚动流水聚合；credits>0 时提供套餐档位摊销选择）
  function tpTierPref() { try { return localStorage.getItem("qp_token_speed_tp_tier") || ""; } catch (e) { return ""; } }
  function ledgerHtml() {
    var s = ledgerToday();
    if (!s.turns) return "";
    var parts = ['<span>' + s.turns + ' 回合</span>', '<span>输出 ' + fmtNum(s.out) + ' tok</span>'];
    if (s.credits > 0) parts.push('<span class="qp-lg-cr">◈ ' + fmtCredits(s.credits) + ' credits</span>');
    if (s.cny > 0) parts.push('<span class="qp-lg-cny">' + fmtMoney(s.cny, '¥') + '</span>');
    if (s.plan > 0) parts.push('<span class="qp-lg-plan">▣ ' + fmtPlan(s.plan) + ' 额度</span>');
    var tierSel = "";
    if (s.credits > 0) {
      var cur = tpTierPref(), plan = null, i;
      for (i = 0; i < TP_PLANS.length; i++) if (TP_PLANS[i].id === cur) plan = TP_PLANS[i];
      var opts = '<option value="">不摊销</option>';
      for (i = 0; i < TP_PLANS.length; i++) {
        var p = TP_PLANS[i];
        opts += '<option value="' + p.id + '"' + (cur === p.id ? ' selected' : '') + '>' + p.name + ' ¥' + p.price + '/月</option>';
      }
      tierSel = '<select id="qp-tp-tier" class="qp-tp-select" title="选择你的 Token Plan 档位，按订阅实际成本摊销今日 credits">' + opts + '</select>';
      if (plan) parts.push('<span class="qp-lg-amort">按 ' + plan.name + ' 摊销 ≈' + fmtMoney(s.credits * plan.price / plan.quota, '¥') + '</span>');
    }
    var models = Object.keys(s.byModel).sort(function (a, b) { return (s.byModel[b].out || 0) - (s.byModel[a].out || 0); }).slice(0, 3);
    var mhtml = models.map(function (m) {
      var b = s.byModel[m];
      return '<span class="qp-lg-m" title="' + b.turns + ' 回合 · 输出 ' + Math.round(b.out) + ' tok">' + escHtml(m) + ' · ' + fmtNum(b.out) + '</span>';
    }).join("");
    return '<div class="qp-d-section">今日消耗<small>本地账本 · 仅本机统计</small>' + tierSel + '</div><div class="qp-lg"><div class="qp-lg-sum">' + parts.join('') + '</div>' +
      (mhtml ? '<div class="qp-lg-models">' + mhtml + '</div>' : '') + '</div>';
  }

  // 详情面板头部 HTML（title/说明/hero 三卡/时间带/用量/Credits 分解/账本/折线图/分段标题）
  // v1.9.0：拆成 head（每拍重绘，数字实时跳）与分段表（增量追加，见 syncSegs）
  function buildDetailHead(r) {
    var segs = r.segments || [], running = r.status === "running", info = statusInfo(r, running);
    var total = r.outputTokens != null ? r.outputTokens : r.attached ? (r.totalGenerated || (r.tokens || 0) + (r.toolTokens || 0) + (r.replayTokens || 0)) : (r.tokens || 0) + (r.toolTokens || 0);
    var estimated = r.tokenSource === "estimate", speed = running ? r.speed : r.genSpeed;
    function row(label, value, tip) {
      return '<div class="qp-c"' + (tip ? ' title="' + escHtml(tip) + '"' : '') + '><span class="qp-cl">' + label + '</span><span class="qp-cv">' + value + '</span></div>';
    }
    function time(label, value, tip) {
      return '<div class="qp-d-time" title="' + escHtml(tip || '') + '"><span>' + label + '</span><strong>' + value + '</strong></div>';
    }
    function waitValue(value) {
      return r.historyOnly || value == null ? '—' : value <= 0 ? '0.0s' : fmtSec(value);
    }
    var note = r.attached ? '<div class="qp-d-note" title="' + ATTACH_TIP + '">中途接入 · 回放 ' + fmtNum(r.replayTokens || 0) + ' tok 不计速</div>' : '';
    if (!running && r.status !== DONE) note += '<div class="qp-d-note">' + escHtml(r.errMsg || info.tip) + '</div>';
    var usage = row("输入用量", r.promptTokens != null ? fmtNum(r.promptTokens) + " tok" : "—", "后端记录的本轮累计输入用量，可能包含多次工具续轮") +
      row("输入 + 输出", r.total ? fmtNum(r.total) + " tok" : "—", "后端本轮累计总用量，不等于新增输出量") +
      row("工具参数 · 含在输出内", r.toolTokens > 0 ? "≈" + fmtNum(r.toolTokens) + " tok" : "—", "工具参数是输出的一部分；拆分量为校准后的估算，不与输出总量重复相加") +
      row("缓存命中 · 含在输入内", r.cacheHit > 0 ? fmtNum(r.cacheHit) + " tok" : "—");
    if (r.afp != null && r.afp > 0) usage += row("套餐抵扣", fmtPlan(r.afp) + " 额度", channelTip(r.channel, r.provider)) + row("其中缓存重计", rebillNote(r.channel, r.cacheHit, r.model).replace(/[（）]/g, '').replace('缓存重计 ', '') || "—");
    if (r.cost != null) usage += r.costUnit === "plan"
      ? row("套餐抵扣", fmtMoney(r.cost, "") + " 额度", channelTip(r.channel, r.provider))
      : r.costUnit === "credits"
        ? row("Credits 消耗", fmtCredits(r.cost) + " credits", channelTip(r.channel, r.provider))
        : row("费用", fmtMoney(r.cost, "¥"), channelTip(r.channel, r.provider));
    if (r.coefRange && r.afpLo != null) usage += row("套餐抵扣 · 参考", fmtPlanRange({lo:r.afpLo,hi:r.afpHi}), ALIAS_TIP);
    if (r.tpRange && r.tpLo != null) usage += row("Credits · 参考", fmtCredits(r.tpLo) + "~" + fmtCredits(r.tpHi) + " credits", "auto 智能路由底层模型不定，按全表当前时刻给参考区间");
    if (r.coefMissing || r.priceMissing || !r.channel) usage += row("计费", r.coefMissing ? "系数未知" : r.priceMissing ? "无价表" : "渠道未识别", channelTip(r.channel,r.provider));
    var observed = !r.historyOnly && speed > 0;
    var speedNote = r.historyOnly ? "历史仅恢复用量，未观测生成速度" : r.attached ? "仅统计接入后有效生成，回放不计速" : "排除首字、工具等待及缓冲冲刷";
    // v1.20.0 燃烧率 caption：当前速度下每分钟烧多少（只算输出侧）
    var burnHtml = "";
    if (running && r.burnRate && r.burnRate.value > 0) {
      burnHtml = '<div class="qp-d-burn">燃烧率 ≈' + (r.burnRate.unit === "credits/min" ? fmtCredits(r.burnRate.value) + ' credits/min' : fmtMoney(r.burnRate.value, '¥') + '/h') + '</div>';
    }
    var sparkHtml = running ? buildSparkline(r.speedHist) : "";
    var html = '<div class="qp-d-title"><div><div class="qp-d-eyebrow">TOKEN SPEED</div><div class="qp-d-heading" id="qp-d-heading">本轮生成概览</div><div class="qp-d-meta">' + escHtml(r.model || "未知模型") + (r.aliasModel ? " · Auto" : "") + ' · ' + channelLabel(r.channel) + (fmtAge(r) ? ' · ' + fmtAge(r) : '') + '</div></div><div class="qp-d-tools"><span class="qp-d-badge ' + escHtml(r.status) + '" title="' + escHtml(info.tip) + '">' + info.text + '</span><button type="button" class="qp-d-close" id="qp-d-close" aria-label="关闭生成详情">×</button></div></div>' + note +
      '<div class="qp-d-hero"><div class="qp-d-card speed"><div class="qp-d-label">' + (running ? '实时生成速度' : '有效生成速度') + '<span class="qp-d-tag">' + (r.historyOnly ? '未观测' : '观测估算') + '</span></div><div class="qp-d-number">' + (observed ? fmtSpeed(speed) : '—') + '<small>tok/s</small></div>' + sparkHtml + '<div class="qp-d-caption">' + speedNote + '</div>' + burnHtml + '</div><div class="qp-d-card"><div class="qp-d-label">本轮输出<span class="qp-d-tag">' + (estimated ? '估算' : '后端用量') + '</span></div><div class="qp-d-number" title="' + Math.round(total).toLocaleString('zh-CN') + ' tok">' + (estimated ? '≈' : '') + fmtNum(total) + '<small>tok</small></div><div class="qp-d-caption">含正文、思考与工具参数</div></div>' + billingCardHtml(r) + '</div>' +
      '<div class="qp-d-timings">' + time("首字等待", r.attached || r.historyOnly ? '—' : fmtMs(r.ttft), "从提交请求到首个输出到达") +
      time("工具 / 空闲等待", waitValue(r.pauseSec), "已观测工具执行与段间空闲等待") + time("工具后模型等待", waitValue(r.modelWaitSec), "工具结束到下一次正文或思考到达，单列记录") +
      time(r.originKnown === false ? "接入后观察" : "总耗时", r.secondsKnown === false || r.seconds == null ? '—' : fmtSec(r.seconds), "从请求开始到结束；中途接入时为已观测时长") + '</div>' +
      '<div class="qp-d-section">用量与计费<small>拆分项已包含在总量内</small></div><div class="qp-d-usage">' + usage + '</div>' +
      tpBreakdownHtml(r) + ledgerHtml() +
      '<div class="qp-d-explain">' + (estimated ? '≈ 表示估算。输出总量在后端用量到达后校准；速度与输出拆分仍为观测估算。' : '输出总量取后端用量；带 ≈ 的速度与拆分项为观测估算。') + '</div>';
    if (!r.historyOnly) html += '<div class="qp-d-section">生成分段<small title="' + escHtml(AVG_TIP) + '">' + segs.length + ' 段' + (r.peak > 0 ? ' · 峰值 ' + fmtSpeed(r.peak) + ' tok/s' : '') + (r.avg > 0 ? ' · 全程均速 ' + fmtSpeed(r.avg) + ' tok/s' : '') + '</small></div><div class="qp-d-chart">' + buildDetailChart(segs) + '</div>';
    if (segs.length) html += '<div class="qp-d-segtitle"><span>分段</span><span>输出量 ≈</span><span>有效时长</span><span>生成速度 ≈</span></div>';
    return html;
  }

  // 单行分段明细 HTML（isCur=该段是进行中的"当前段"）
  function segRowHtml(s, i, isCur) {
    return '<span class="qp-ri">#' + (i + 1) + "</span>" +
      '<span class="qp-rt">' + Math.round(s.tokens) + " tok</span>" +
      '<span class="qp-rd">' + ((s.t1 - s.t0) / 1000).toFixed(1) + "s</span>" +
      '<span class="qp-rs" title="速度仅按包间增长计算，排除首包和缓冲冲刷；总量仍包含全部输出">'
        + (s.t1 - s.t0 > 50 && measuredSegTokens(s) > 0 ? "≈" + segSpeed(s).toFixed(1) + " tok/s" : "—") + "</span>";
  }
  function appendSegRow(box, s, i, isCur) {
    var row = document.createElement("div");
    row.className = "qp-d-row" + (isCur ? " qp-d-cur" : "");
    row.innerHTML = segRowHtml(s, i, isCur);
    box.appendChild(row);
  }
  // 分段表增量同步（v1.9.0）：只把新出现的段追加到表尾，已有行不动、滚动位置不丢；
  // 数据回退（会话切换 / 换了结果）才整体重建；最后一行是"当前段"时只更新它自身数字
  function syncSegs(box, segs, live) {
    var n0 = box.children ? box.children.length : 0;
    if (segs.length < n0) { box.innerHTML = ""; n0 = 0; }
    for (var i = n0; i < segs.length; i++) {
      appendSegRow(box, segs[i], i, live && i === segs.length - 1);
    }
    // Calibrating usage can change EVERY previous row, even when the count is
    // unchanged. Update changed content in place; retain row nodes and scroll.
    for (var j = 0; j < segs.length; j++) {
      var row = box.children && box.children[j];
      if (!row) continue;
      var current = !!live && j === segs.length - 1;
      var html = segRowHtml(segs[j], j, current);
      if (row.innerHTML !== html) row.innerHTML = html;
      row.className = "qp-d-row" + (current ? " qp-d-cur" : "");
    }
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- 详情面板实时刷新（v1.7.0） ----------
  // 旧版面板是"点开那一刻"的快照，生成中想看得关掉再点开。现在面板打开期间
  // 600ms 轮询，数据变了就地重绘（同一个元素换 innerHTML，保留滚动位置），
  // 回合结束/会话切换自动跟上；数据没变就不动（省重排、也不白刷屏）。
  var detailTimer = null;
  var detailSig = "";

  function detailIsLive(sid) {
    var st = getActiveStream(sid);
    return !!(st && st.tFirst);
  }
  // 面板内容签名：变了才重绘（token 数 / 段数 / 当前段进度 / 等待 / 耗时秒 / 回放态）
  function detailSignature(sid) {
    var st = getActiveStream(sid);
    if (st && st.tFirst) {
      return ["L", sid, st.tokenCount, st.toolTokens, (st.segments ? st.segments.length : 0),
        Math.round((st.currentSeg ? st.currentSeg.tokens : 0) / 20),
        Math.round(st.pauseMs / 1000), Math.round((now() - st.t0) / 1000),
        st.attached ? 1 : 0, st.replayTokens || 0, Math.round((st.peakMax || 0) / 5),
        Math.round(st.lastSpeed || 0)].join("|");
    }
    var rr = loadLastResult(sid);
    return rr ? ["D", sid, rr.ts || 0, rr.status || "", (rr.segments || []).length].join("|") : "E|" + sid;
  }
  // 生成中快照（面板实时刷新与点击展开共用，口径与 endTurn 对齐）
  function liveSnapshot(st) {
    var segs = st.segments.slice();
    if (st.currentSeg && st.currentSeg.tokens > 0) segs.push(st.currentSeg);
    var _replayN = st.attached ? (st.replayTokens || 0) : 0;
    var _liveEl = (st.attached && st.liveStartT) ? (now() - st.liveStartT) / 1000 : (now() - st.t0) / 1000;
    var _costTok = st.tokenCount + (st.toolTokens || 0) + _replayN; // v1.12.0：运行中金额含工具参数
    var _ch = channelOf(st);
    var _money = moneyFields(_ch, st.model, st.promptTokens, _costTok, st.cacheHitTokens);
    return {
      model: st.model, status: "running", ttft: st.attached ? 0 : st.ttft,
      promptTokens: st.promptTokens,
      tokens: st.tokenCount, toolTokens: st.toolTokens || 0, total: st.totalTokens,
      outputTokens: _costTok, tokenSource: "estimate",
      seconds: (now() - st.t0) / 1000,
      genTime: 0, genSpeed: 0, pauseSec: observedWaitMs(st) / 1000,
      modelWaitSec: (st.modelWaitMs + (st.toolResumeAt ? Math.max(0, now() - st.toolResumeAt) : 0)) / 1000,
      speed: st.lastSpeed || 0,
      segments: segs, cacheHit: st.cacheHitTokens || 0,
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
      // v1.20.0：TokenPlan 明细 / auto 区间 / 燃烧率 / sparkline 采样
      tp: _money.tp,
      tpLo: _money.tpLo,
      tpHi: _money.tpHi,
      tpRange: _money.tpRange,
      burnRate: burnRateOf(_ch, st.model, st.lastSpeed || 0, st.promptTokens),
      speedHist: st.speedHist ? st.speedHist.slice() : [],
      // v1.14.1：不变量——峰值不可能低于平均（与 endTurn 同款兜底；此处 avg/peak 同为
      // wall-clock 口径，兜底无口径差）
      peak: Math.max(st.peakMax || 0, _liveEl > 0.1 ? st.tokenCount / _liveEl : 0),
      avg: _liveEl > 0.1 ? st.tokenCount / _liveEl : 0, ts: 0,
      attached: st.attached,
      replayTokens: _replayN,
      totalGenerated: st.attached ? (st.totalGenerated || _costTok) : 0
    };
  }
  function bindDetailClose(p) {
    var c = document.getElementById("qp-d-close");
    if (c && c.addEventListener) {
      c.addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        closeDetail();
      });
    }
  }
  // v1.20.0：套餐档位选择（今日账本摊销）——换档就地强制重绘（签名不变也要刷）
  function bindTierSelect() {
    var sel = document.getElementById("qp-tp-tier");
    if (!sel || !sel.addEventListener) return;
    sel.addEventListener("change", function () {
      try { localStorage.setItem("qp_token_speed_tp_tier", sel.value || ""); } catch (e) { /* ignore */ }
      var sid = getSessionId(), st = getActiveStream(sid);
      refreshDetail(st && st.tFirst ? liveSnapshot(st) : loadLastResult(sid));
    });
  }
  // v1.9.0：paintDetail 拆"头 + 分段表"两步——head 每拍重绘（数字实时跳），
  // 分段表增量追加（已有行不重建，滚动位置不丢）
  function paintDetail(p, snap, live) {
    var top = p.scrollTop || 0;
    // 骨架（head 容器 + 分段表容器）只在首次构建
    if (!p.querySelector(".qp-d-head")) {
      p.innerHTML = "";
      var hd = document.createElement("div"); hd.className = "qp-d-head"; p.appendChild(hd);
      var bx = document.createElement("div"); bx.className = "qp-d-segs"; bx.id = "qp-d-segs"; p.appendChild(bx);
    }
    var headEl = p.querySelector(".qp-d-head");
    if (headEl) headEl.innerHTML = buildDetailHead(snap);
    bindDetailClose(p);   // head 换 innerHTML 后关闭按钮是新节点，得重新绑
    bindTierSelect();     // v1.20.0 档位选择同理
    var box = p.querySelector(".qp-d-segs");
    if (box) syncSegs(box, snap.segments || [], !!live);
    p.scrollTop = top;
  }
  // forceR：直接拿这份结果重绘（回合结束用，避免再读一次 localStorage）
  function refreshDetail(forceR) {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var sid = getSessionId();
    var sig = detailSignature(sid);
    if (!forceR && sig === detailSig) return;
    var live = detailIsLive(sid);
    var snap = forceR || (live ? liveSnapshot(getActiveStream(sid)) : loadLastResult(sid));
    if (!snap) { closeDetail(); return; }
    detailSig = sig;   // 存"这一拍用的"签名，别存重算后的新签名（否则会白跳一拍）
    paintDetail(p, snap, live);
  }

  // v1.13.0（评审 P2-3）：ESC 关闭详情面板
  function onDetailKeydown(e) {
    if (e && (e.key === "Escape" || e.keyCode === 27)) closeDetail();
  }
  function closeDetail() {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    detailSig = "";
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    document.removeEventListener("click", onDocClickDetail, true);
    document.removeEventListener("keydown", onDetailKeydown, true);
  }
  function onDocClickDetail(e) {
    // 点面板外关闭
    var p = document.getElementById(PANEL_ID);
    if (p && !p.contains(e.target)) closeDetail();
  }
  function openDetail(r) {
    closeDetail();
    var p = document.createElement("div");
    p.id = PANEL_ID;
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-labelledby", "qp-d-heading");
    // 面板内点击不冒泡到 document（否则点面板内任意处都会关）
    p.addEventListener("click", function (e) { e.stopPropagation(); });
    document.body.appendChild(p);
    paintDetail(p, r, !!(r && r.status === "running")); // v1.9.0：统一走增量渲染
    detailSig = detailSignature(getSessionId());
    setTimeout(function () {
      // v1.20.0 稳定性：面板若已在同一拍内被关掉，不再挂 document 监听（旧版会留下孤儿监听器）
      if (document.getElementById(PANEL_ID)) document.addEventListener("click", onDocClickDetail, true);
    }, 0);
    document.addEventListener("keydown", onDetailKeydown, true); // v1.13.0：ESC 关闭
    detailTimer = setInterval(function () {
      if (!document.getElementById(PANEL_ID)) { clearInterval(detailTimer); detailTimer = null; return; }
      try { refreshDetail(); } catch (e) { /* 刷新失败不影响统计与悬浮条 */ }
    }, 600);
  }

  function onBarClick(e) {
    e.stopPropagation();
    if (document.getElementById(PANEL_ID)) { closeDetail(); return; }
    var sid = getSessionId();
    var st = getActiveStream(sid);
    if (st && st.tFirst) {
      openDetail(liveSnapshot(st)); // 生成中：活 state 现场构建（面板自己会继续跟）
      return;
    }
    var r = loadLastResult(sid);
    if (r) openDetail(r);
  }

  // ════════════════════════════════════════════════════════════
  // 15-ui-mount.js · 挂载与定位（fixed 脱离 React 树）/ 标语隐藏 / 会话切换
  // ════════════════════════════════════════════════════════════
  // ---------- 位置与挂载（fixed，脱离 React 树） ----------

  function isOnChatPage() {
    return !!(document.querySelector(
      ".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input'], " +
      ".qwenpaw-chat-anywhere-message-list, .qwenpaw-bubble-list-scroll"
    ));
  }

  function positionBar() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) return;
    if (!isOnChatPage()) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    var inputBox = document.querySelector(".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input']");
    if (inputBox) {
      var rect = inputBox.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.top > 0) {
        bar.style.bottom = Math.max(64, window.innerHeight - rect.top + 6) + "px";
        // 水平中心 = 输入框容器中心（不是视口中心：右侧挂边栏时视口居中会偏）
        var cx = rect.left + rect.width / 2;
        var half = bar.offsetWidth / 2;
        if (half > 0) cx = Math.max(half + 4, Math.min(cx, window.innerWidth - half - 4)); // 防极端出视口
        bar.style.left = cx + "px";
        bar.style.transform = "translateX(-50%)";
        return;
      }
    }
    // v1.5.0：聊天页上锚点丢失不再静默（旧版 QwenPaw 改版时 bar 位置会悄悄回退默认）
    warnOnce("anchor", "聊天页上找不到输入框容器（.qwenpaw-chat-anywhere-input），悬浮条位置回退默认——QwenPaw 前端可能已改版");
    bar.style.bottom = "96px";
    bar.style.left = "50%";
    bar.style.transform = "translateX(-50%)";
  }

  // v1.13.0（评审 P0-3）：扫 body 时排除聊天气泡/消息正文与本插件自己的 DOM——
  // 标语是"页面上的独立小节点"，而用户消息里出现"懂你所需/伴你左右"时它的父节点
  // 也可能是个 <30 字的短元素，旧版会把用户气泡整块 display:none（实测未触发，属预防）
  function insideChatOrPlugin(el) {
    try {
      for (var p = el, i = 0; p && i < 8; i++, p = p.parentElement) {
        if (p.id === BAR_ID || p.id === PANEL_ID) return true;
        var cls = (typeof p.className === "string") ? p.className : "";
        if (!cls) continue;
        if (cls.indexOf("qp-") >= 0) return true;
        if (/(bubble|markdown|message|prose|chat-|assistant|user-)/i.test(cls)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // v1.20.0 稳定性/性能：标语隐藏短路。旧版每 3s 全量 TreeWalker 扫 body 所有文本节点，
  // 长会话里是纯浪费。标语是落地页静态节点——隐藏成功一次后就不再扫（会话切换重置；
  // 主循环每 30s 强制复扫一次兜底 React 重挂载）。首次没扫到不置位，继续 3s 一扫直到命中。
  var anchorHidden = false;
  function resetAnchorScan() { anchorHidden = false; }
  function hideAnchor(force) {
    if (anchorHidden && !force) return;
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var t = n.textContent || "";
          return (t.indexOf("懂你所需") >= 0 || t.indexOf("伴你左右") >= 0)
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var n, hid = false;
      while ((n = walker.nextNode())) {
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
    } catch (e) { /* ignore */ }
  }

  function refreshBarContent() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) { injectBar(); return; }
    var sid = getSessionId();
    var activeSt = getActiveStream(sid);
    if (activeSt) {
      bar.className = "running";
      // v1.7.0：走统一视图（旧版这里写死 speed:0 且丢 attached/replay 标记，
      // 切到正在生成中的会话时悬浮条会显示错误口径）
      bar.innerHTML = !activeSt.tFirst && !activeSt.attached ? buildWaitingHtml() : buildRunningHtml(runningView(activeSt));
    } else {
      if (states[sid] && states[sid].suspended) {
        bar.className = "running";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>正在重新接入后台生成…</span>';
        positionBar();
        return;
      }
      var r = loadLastResult(sid);
      if (r) {
        bar.className = r.status === DONE ? "done" : r.status;
        bar.innerHTML = buildResultHtml(r);
      } else {
        bar.className = "";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>暂无数据，发一条消息试试</span>';
      }
    }
    positionBar();
  }

  function injectBar() {
    if (document.getElementById(BAR_ID)) return true;
    var bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.title = "点击查看本轮速度、用量和耗时";
    bar.setAttribute("role", "button");
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-label", "查看本轮生成详情");
    bar.addEventListener("keydown", function(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBarClick(e); } });
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
      resetAnchorScan(); // v1.20.0：新会话的落地页标语要重新扫
      refreshBarContent();
    }
    ["pushState", "replaceState"].forEach(function (name) {
      var original = window.history[name];
      if (typeof original !== "function") return;
      window.history[name] = function () {
        var result = original.apply(this, arguments);
        try { changed(); } catch (eRoute) { /* never interfere with navigation */ }
        return result;
      };
    });
    window.addEventListener("popstate", changed);
  }

  // v1.15.0: one cursor for idle accounting; never overwrite the last body timestamp.
  function maintainStream(st, t) {
    if (st.active && !(st.attached && !st.replayDone) && (st.toolPending || st.toolResumeAt)) {
      if (st.__sid === getSessionId()) renderRunning(runningView(st, {speed: 0}));
      return;
    }
    if (!st.active || (st.attached && !st.replayDone) || st.toolPending || !st.tLast || t - st.tLast <= 2000) return;
    closeCurrentSeg(st);
    st.pauseMs += Math.max(0, t - Math.max(st.tLast, st.idleAccountedUntil || 0));
    st.idleAccountedUntil = t;
    st.lastSpeed = 0; st.window = []; st.evWin = [];
    if (st.__sid === getSessionId()) renderRunning(runningView(st, {speed: 0}));
  }
  // ════════════════════════════════════════════════════════════
  // 16-init.js · 初始化与 1s 主循环（停顿补测 / error 帧延迟判定）
  // ════════════════════════════════════════════════════════════
  // ---------- 初始化 ----------
  // v1.20.0 稳定性：子系统各自隔离——样式/挂载/路由/渠道任何一个失败都不拖垮统计主循环
  function init() {
    try { injectStyles(); } catch (e) { /* ignore */ }
    try { injectBar(); } catch (e) { /* ignore */ }
    try { installRouteTracking(); } catch (e) { /* ignore */ }
    try { refreshActiveLlm(false); } catch (e) { /* ignore */ } // v1.8.0：尽早拿真实渠道/模型（并修正旧版结果里错的金额）
    // v1.20.0：窗口尺寸变化立即重定位（旧版只靠 1s 轮询，拖拽窗口时悬浮条会漂一秒）
    try { window.addEventListener("resize", function () { try { positionBar(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }

    var lastSession = getSessionId();
    var slowTick = 0;
    setInterval(function () {
      try {
        slowTick++;
        var curSession = getSessionId();

        // 1) 活跃流维护：停顿补测（流尾部工具等待漏计兜底）+ 挂起的 error 帧延迟判定
        Object.keys(states).forEach(function (sid) {
          var st = states[sid];
          if (!st || !st.active) return;
          // 1a) v1.8.0：见过 error 帧后 1.6s 内没有新事件 → 判定流真的死了（有输出按"已中断"）
          if (st.pendingError && st.lastEventAt && (now() - st.lastEventAt) > 1600) {
            finishAbnormal(st, st.pendingError, "error_frame");
            return;
          }
          maintainStream(st, now());
        });

        // 2) 会话切换：fixed bar 不销毁重建（无闪动），只刷新内容
        if (curSession !== lastSession) {
          lastSession = curSession;
          resetAnchorScan(); // v1.20.0
          refreshBarContent();
          return;
        }

        // 3) 位置校正 + 存活维护
        positionBar();
        if (!document.getElementById(BAR_ID)) injectBar();

        // 4) 低频（3s 一次）：disclaimer 隐藏维护；命中后短路，30s 强制复扫兜底重挂载
        if (slowTick % 3 === 0) hideAnchor(slowTick % 30 === 0);
      } catch (eLoop) { /* 单拍失败不终止主循环 */ }
    }, 1000);

    try {
      var observer = new MutationObserver(function () {
        if (!document.getElementById(BAR_ID)) injectBar();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () { observer.disconnect(); }, 20000);
    } catch (eObs) { /* 无 MutationObserver 环境靠 1s 轮询兜底 */ }
  }


  // fetch 拦截要最早生效
  if (typeof window !== "undefined") {
    patchFetch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// 实时指标：channelOf / runningView / tick / endTurn 收尾校准（原 09-metrics）
import { store } from "./store.js";
import { renderer } from "./renderer.js";
import { DONE, SEG_CAP } from "./constants.js";
import { now, warnOnce } from "./utils.js";
import { pushWin, closeCurrentSeg, measuredSegTokens } from "./state.js";
import { getSessionId } from "./session.js";
import { getCurrentModel } from "./model.js";
import { resolveChannel, providerBaseUrl, currentChannel, refreshActiveLlm } from "./channel.js";
import { tokenplanEntryFor, tpTier, tpFactor, priceTableFor, isPeakHour, tpNightActive, moneyFields } from "./pricing.js";
import { calibrateRatio, estimateTokens } from "./tokens.js";
import { loadLastResult, saveLastResult } from "./persistence.js";
import { appendLedger } from "./ledger.js";
import { flushCensus } from "./diagnostics.js";

// 本回合渠道——SSE usage 里的 provider（最准，中途才到）优先于配置渠道
export function channelOf(st) {
  if (st && st.providerUsage) {
    var ch = resolveChannel(st.providerUsage, providerBaseUrl(st.providerUsage));
    if (ch) return ch;
  }
  return (st && st.channel) || "";
}

// 燃烧率：按当前解码速度，每分钟烧掉多少（credits/min 或 ¥/h）。
// 只算输出侧——输入是请求时一次性计费，不属于流式期间的"燃烧"。无价表 → null（不猜）。
export function burnRateOf(channel, model, speed, promptTok) {
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
    if (t) outPrice = (isPeakHour(t) && t.peak ? t.peak : t.offPeak).output;
  } else if (ch === "dashscope") {
    var de = tokenplanEntryFor(model);
    if (de) outPrice = tpTier(de, promptTok || 0).tier.output * (de.bailianPeak && tpNightActive(Date.now()) ? de.night : 1);
  }
  if (outPrice == null) return null;
  return { value: speed * outPrice / 1e6 * 3600, unit: "¥/h" };
}

// 三处"生成中"渲染（tick / 停顿补测 / 会话切换刷新）共用同一份视图数据，避免口径漂移
export function observedWaitMs(st) {
  return st.pauseMs + (st.toolPending && st.toolStartT && !(st.attached && !st.replayDone)
    ? Math.max(0, now() - st.toolStartT) : 0);
}
export function runningView(st, opts) {
  opts = opts || {};
  var _replay = st.attached ? st.replayTokens || 0 : 0;
  var _tool = st.toolTokens || 0;
  var _costTok = st.tokenCount + _tool + _replay; // 实时金额含工具参数
  var _ch = channelOf(st);
  // 实时金额统一走 moneyFields（与 endTurn/liveSnapshot 同源，杜绝三处各写一份漂移）
  var _m = moneyFields(_ch, st.model, st.promptTokens, _costTok, st.cacheHitTokens);
  var _speed = typeof opts.speed === "number" ? opts.speed : st.lastSpeed || 0;
  return {
    ttft: st.attached ? 0 : st.ttft,
    speed: _speed,
    model: st.model,
    tokens: _costTok,     // 已生成 = 回放 + 接入后（总量口径，不含工具参数）
    toolTokens: _tool,                   // 工具参数单列
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
    // TokenPlan 明细 / auto 区间 / 燃烧率（其他渠道 tp=null，UI 判空）
    tp: _m.tp,
    tpLo: _m.tpLo,
    tpHi: _m.tpHi,
    tpRange: _m.tpRange,
    burnRate: burnRateOf(_ch, st.model, _speed, st.promptTokens)
  };
}

export function tick(st) {
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
  // 全程实时追踪峰值。批量冲刷不入峰值——单片 >600 tok 且它贡献了窗口增长的一半以上，
  // 说明这一窗口是"一大坨一次性砸进来"（补发尾巴/网关缓冲刷出），不是模型解码速度
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
  // 原始速度（不做任何剔除）单独留档——诊断与"峰值 ≥ 平均"兜底用
  if (speed > (st.peakRaw || 0)) st.peakRaw = speed;
  // 冲刷判定收紧——必须"静默之后砸下来"才算补发尾巴/网关缓冲刷出。
  // 旧版只看"单片 >600 tok 且贡献窗口增长过半"，高分片模型正常流式本身就按大片推送，会被误剔
  if (_flushTok > 0 && _dtW > 0.1) {
    st.flushPeak = true;
    speed = Math.max(0, (_dtokW - _flushTok) / _dtW);
  } else if (_maxEv > 600 && _dtW > 0.1 && _maxEv * 2 > _dtokW) {
    st.flushSkipped = (st.flushSkipped || 0) + 1;
  }
  if (speed > st.peakMax) st.peakMax = speed;
  st.lastSpeed = speed; // 详情面板实时刷新要显示这个速率
  // sparkline 采样（≥200ms 一点，环形 120 点 ≈ 最近 24s+ 的速度轨迹）
  if (t - (st.lastSpeedSampleT || 0) >= 200) {
    st.lastSpeedSampleT = t;
    st.speedHist.push([t, speed]);
    if (st.speedHist.length > 120) st.speedHist.shift();
  }
  if (st.__sid === getSessionId()) {
    renderer.renderRunning(runningView(st));
  }
}

export function endTurn(status, st, errMsg, endCause) {
  if (!st || !st.active) return;
  st.active = false;
  st.pendingError = "";
  st.lastTouched = Date.now();
  st.errMsg = String(errMsg || "").slice(0, 80);
  st.endCause = endCause || st.endCause || (status === DONE ? "stream_end" : "");
  if (!st.model) st.model = getCurrentModel(); // 兜底：全程无 model 事件且发送时 DOM 未读到
  if (!st.model) {
    // 会话级模型记忆——同一会话上一回合的模型大概率没变
    var _last = loadLastResult(st.__sid);
    if (_last && _last.model) st.model = _last.model;
  }
  // 计费渠道：usage.provider_id（本回合真值）→ /api/models/active（当前配置）
  // → 本会话上一回合的记忆 → 模型名兜底（只对 deepseek 名敢下结论）。全拿不到就留空
  var _ch = currentChannel(st.providerUsage);
  if (!_ch.channel) {
    var _pr = loadLastResult(st.__sid);
    if (_pr && _pr.channel) _ch = { channel: _pr.channel, provider: _pr.provider || "", src: "memory" };
  }
  st.channel = _ch.channel;
  st.channelSrc = _ch.src || "";
  st.provider = _ch.provider || (store.activeLlm && store.activeLlm.providerId) || "";
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
  // - agentic 回合（有停顿/多段）：精确生成量远超流式估算（>×2.5+30）判定为会话累计值
  var looksCumulative = false; // true = 显示口径保留估算
  var implausible = false;     // true = usage 本身脏，计费也回退估算
  var usageOverwrite = false;  // tokenCount 已被精确 usage 覆盖（分段需换算口径）
  if (st.finalUsage && st.finalUsage.generated >= 0) {
    var _gen = st.finalUsage.generated;
    st.totalTokens = st.finalUsage.total;
    st.totalGenerated = _gen; // 整轮真实生成量（中途接入时含回放部分）
    var elapsed0 = (now() - st.t0) / 1000;
    var pureChat = !st.attached && st.pauseMs < 2000 && st.segments.length <= 2;
    // 精确 completion 含工具参数，而 st.tokenCount 只含正文 → 比较与拆分都必须用"正文估算 + 工具估算"合计
    var _estText = st.tokenCount;        // 当前仍是正文估算（usageOverwrite 前）
    var _estTool = st.toolTokens;
    var _estAll = _estText + _estTool;
    if (st.attached) {
      // Calibrate all observed partitions together, preserving the replay/live split.
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
      // 精确 completion 按"正文估算 : 工具估算"拆成两份：正文进 tokenCount，工具进 toolTokens
      if (_estAll > 0) {
        st.toolTokens = _gen * (_estTool / _estAll);
        st.tokenCount = _gen - st.toolTokens;
      } else {
        st.tokenCount = _gen; // 两侧估算都为 0（纯兜底）：整额给正文，行为同旧版
      }
      usageOverwrite = true;
    }
  }
  // 中途接入时 fullText 含回放内容，不能拿它回填 live 口径（否则速度被虚高）
  if (!usageOverwrite && !st.tokenCount && st.fullText && !st.attached) {
    st.tokenCount = estimateTokens(st.fullText, st.model);
  }
  // 回合在工具执行期收尾（打断/结束）时，把这段等待也记账，别摊进正文速度
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
  // 中途接入时平均速度的分母用"接入后时长"（t0 起算会把回放窗口算进去）
  var liveElapsed = st.attached && st.liveStartT ? (now() - st.liveStartT) / 1000 : elapsed;
  var avg = (st.attached ? liveElapsed : elapsed) > 0.1 ? st.tokenCount / (st.attached ? liveElapsed : elapsed) : 0;
  // 峰值 = tick() 全程实时追踪的 peakMax
  var peak = st.peakMax || 0;
  // 分段口径统一：usage 被采信时，分段 token 与峰值按 tokenCount/segSum 比例换算到精确口径（钳制 0.2~5）
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
  // 保底：峰值 ≥ 折线图最高段速（同一换算口径），杜绝"图高于峰值"的观感矛盾
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
  // Wall-clock throughput includes the first packet; measured window speed does not.
  // 不变量兜底（展示自洽优先）——多窗口回合两口径可倒挂；此时取较大者，不展示"平均 > 峰值"。
  // 单包/无可测窗口回合不兜：一个瞬时大包不能建立峰值，保持"不捏造"决策。
  if (measuredTokens > 0 && avg > peak) peak = avg;
  // 费用 output 侧优先精确 completion_tokens；usage 脏（非物理）时回退估算
  var costCompletion = st.finalUsage && st.finalUsage.completionTokens >= 0 && !implausible
    ? st.finalUsage.completionTokens : st.tokenCount + st.toolTokens + (st.replayTokens || 0);
  // 金额口径统一走 moneyFields（渠道决定套餐额度还是人民币，互斥）
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
    toolTokens: st.toolTokens || 0, // 工具调用参数 token（单列，不进正文速度）
    total: st.totalTokens,
    seconds: elapsed,
    genTime: genTime,
    genSpeed: genSpeed,
    pauseSec: st.pauseMs / 1000,
    modelWaitSec: st.modelWaitMs / 1000,
    segments: st.segments.slice(-SEG_CAP), // 全量给详情面板（上限 200 段）
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
    avg: avg,
    peak: peak,
    flushPeak: !!st.flushPeak, // 峰值里剔除过批量冲刷
    peakRaw: st.peakRaw || 0,  // 未剔除冲刷的原始峰值（诊断）
    flushSkipped: st.flushSkipped || 0, // 疑似冲刷但按连续流保留的次数
    status: status,
    // 中途接入口径
    attached: st.attached,
    replayTokens: st.replayTokens,
    totalGenerated: st.totalGenerated || 0,
    liveTokens: st.tokenCount
  };
  // ratio 自校准（按模型分表；防累计污染判定不变；钳制 0.2~5）
  if (usageOverwrite && !st.attached && !looksCumulative && st.estimatedTokens > 10 && st.tokenCount > 0) {
    var newRatio = st.tokenCount / st.estimatedTokens;
    if (newRatio > 0.2 && newRatio < 5) {
      calibrateRatio(String(st.model || "").toLowerCase(), newRatio);
    }
  }
  // 诊断：本轮"最大单片/回放结束原因/静默后又来大坨的次数/各段事件数"落 localStorage（不落任何正文）
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
  // 页面刷新中止的回合不落库、不渲染（浏览器在卸载，别把上条好结果洗掉）
  if (st.endCause !== "page_refresh") {
    flushCensus();
    saveLastResult(st.__sid, st.lastResult); // 按流所属会话存
    appendLedger(st.__sid, st.lastResult);   // 会话账本（sid+messageId upsert，刷新恢复不重复计账）
    if (st.__sid === getSessionId()) renderer.renderDone(st.lastResult);
  }
  // 释放大字段
  st.fullText = ""; st.seenFullText = ""; st.window = []; st.segments = [];
  st.textSnapshots = Object.create(null); st.evWin = []; st.probeWin = []; st.replayWin = [];
  st.speedHist = [];
}
// 回合生命周期：startTurn / addDelta（回放识别）/ handleEvent（原 08-turn）
// 统计全部显式传 st；多流并发安全。渲染经 renderer 总线，不直接依赖 DOM。
import { store } from "./store.js";
import { renderer } from "./renderer.js";
import { now, warnOnce } from "./utils.js";
import { estimateTokens, rawEstimate, extractUsage } from "./tokens.js";
import { pushWin, closeCurrentSeg } from "./state.js";
import { getCurrentModel, extractFullText } from "./model.js";
import { currentChannel, refreshActiveLlm } from "./channel.js";
import { getSessionId } from "./session.js";
import { debugLogEvent } from "./diagnostics.js";
import { runningView, tick } from "./metrics.js";

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

export function startTurn(t0, st, epoch, options) {
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
  st.epoch = epoch || 0; // 本回合所属流纪元（旧流事件据此丢弃）
  st.lastTouched = Date.now();
  st.t0 = typeof origin === "number" ? origin : now();
  st.tFirst = 0;
  st.ttft = 0;
  st.charCount = 0;
  st.tokenCount = 0;
  st.estimatedTokens = 0;
  st.peakMax = 0;
  st.peakRaw = 0;        // 未剔除冲刷的原始峰值
  st.flushSkipped = 0;   // 看着像冲刷、实为连续流而未剔除的次数
  st.toolCharCount = 0; // 工具参数逐轮重置
  st.toolEstTokens = 0;
  st.toolTokens = 0;
  st.toolPending = false; // 语义分段：当前是否处于工具执行区间
  st.toolStartT = 0;
  st.toolCalls = Object.create(null);
  st.toolMessageCalls = Object.create(null);
  st.finishedTools = Object.create(null);
  st.modelWaitMs = 0; st.toolResumeAt = 0;
  st.textSnapshots = Object.create(null);
  st.idleAccountedUntil = 0;
  st.prevEventAt = 0;
  st.evWin = [];          // 2s 内"单片 token 数"窗口（判批量冲刷）
  st.flushPeak = false;   // 本轮出现过被剔除的批量冲刷
  st.diagMax = null;      // 诊断：最大单片
  st.diagReplayEnd = "";  // 诊断：回放结束原因
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
  // 回放识别字段必须逐轮重置，否则一次中途接入会让该会话永久"接入态"
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
  st.speedHist = [];        // sparkline 逐轮重置
  st.lastSpeedSampleT = 0;
  // 计费渠道/收尾取证逐轮重置（否则上一轮的 provider 会在本轮 usage 到达前冒充本轮的渠道证据）
  st.providerUsage = "";
  st.endCause = "";
  st.errMsg = "";
  st.pendingError = "";
  st.userStopped = false;
  st.lastEventAt = now();
  var _boot = currentChannel("");   // 先用当前配置/记忆定个渠道（金额显示才不至于空一拍）
  st.channel = _boot.channel;
  st.channelSrc = _boot.src || "";
  st.provider = _boot.provider || (store.activeLlm && store.activeLlm.providerId) || "";
  refreshActiveLlm(false);          // 顺便刷新一次 /api/models/active（20s 内不重复请求）
  if (st.__sid === getSessionId()) {
    if (st.explicitReplay) renderer.renderReplay(st);
    else renderer.renderWaiting();
  }
}

export function addDelta(text, st, evt) {
  if (!st || !text) return;
  // 有新内容说明流还活着 → 作废挂起的 error 帧（它不代表本轮真的死了）
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
    renderer.renderReplay(st);
    return;
  }
  // 诊断：记下本轮"最大单片"（多少 tok / 多少字符 / 什么时候 / 当时处于哪个阶段）
  if (!st.diagMax || deltaTok > st.diagMax.tok) {
    st.diagMax = {
      tok: Math.round(deltaTok), chars: clean.length, at: Math.round(t - st.t0),
      phase: st.replayDone ? "live" : st.attached ? "replay" : "probe"
    };
  }
  // 单片 token 窗口（判"批量冲刷"用；只在 live 段有效，回放/探测期无所谓）
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

  // ---- 中途接入回放识别 ----
  // 切换/中途打开对话时，QwenPaw 会把本轮已生成内容经同一 SSE 补发进来，
  // 速率远超物理解码上限。照单全收会算出失真值 → 识别后剔除：
  // 回放 token 只记入 replayTokens，不进 tokenCount/segments/速度/峰值。
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
        st.diagReplayEnd = "probe_flush"; // 诊断：探测期就认出是补发
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
        st.toolCharCount = 0; st.toolEstTokens = 0; st.toolTokens = 0;
        st.toolPending = false; st.toolStartT = 0; st.toolCalls = Object.create(null);
        st.evWin = []; st.tLast = 0; st.idleAccountedUntil = 0;
        st.tFirst = t; st.ttft = 0; // 首字是回放首包，无意义；tFirst 仅作"已在生成"标志
        st.replayTokens = st.probeTokens; // 含本次 delta（下方直接 return，不会重复累加）
        st.replayLastT = t;
        st.replayWin = [[t, st.replayTokens]];
        renderer.renderReplay(st); // 悬浮条立刻切"回放中"，别让用户盯着 0 tok/s
        return;
      }
      if (_age > 6000 && _wr <= 800) {
        st.replayDone = true; // 前 6s 无回放特征 → 正常生成
        st.diagReplayEnd = "probe_normal";
      }
    }
    if (st.attached) {
      // 回放态：真静默 = 上一次**任意**事件（含工具帧/参数帧）也过了 >1.5s。
      // 旧版只看正文 delta，而补发的 agentic 历史里本来就有工具执行的间隔 → 误判"补发结束"
      var _silent = st.prevEventAt && t - st.prevEventAt > 1500;
      var _added = false;
      if (!_silent) {
        st.replayTokens += deltaTok; _added = true;
        st.replayLastT = t;
        pushWin(st.replayWin, t, st.replayTokens);
        if (st.replayWin.length >= 2) {
          var _rdt = (t - st.replayWin[0][0]) / 1000;
          // 证据窗口从 0.5s 收紧到 1.2s，防补发途中的慢段误判"已恢复生成"
          if (_rdt > 1.2 && (st.replayTokens - st.replayWin[0][1]) / _rdt < 500) {
            st.replayDone = true; // 速率降至物理解码水平 → live
            st.diagReplayEnd = "rate_low";
          }
        }
        if (!st.replayDone && t - st.t0 > 90000) {
          st.replayDone = true; // 兜底：回放态最长 90s
          st.diagReplayEnd = "cap90s";
        }
      } else if (deltaTok > 600) {
        // 静默后砸下来的是一大坨 → 还是补发的尾巴（网关/后端冲刷），不是真生成
        st.replayTokens += deltaTok; _added = true;
        st.replayLastT = t;
        pushWin(st.replayWin, t, st.replayTokens);
        st.diagFlushAfterSilent++;
      } else {
        st.replayDone = true; // 静默 >1.5s 且只是一小片正文 = 真的恢复生成了
        st.diagReplayEnd = "silent_small";
      }
      if (!st.replayDone) { renderer.renderReplay(st); return; } // 仍在回放：不进 tokenCount/分段/速度
      if (_added) { st.replayTokens -= deltaTok; st.replayWin.pop(); } // 本事件归 live，不重复计
      st.currentSeg = null; // live 分段从接入后重新计（回放窗口不并入第一段）
    }
  }

  // 语义分段：工具期结束后回来的第一片正文 = 新段起点。正常路径下
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
    st.currentSeg.ev++; // 诊断
    if (deltaTok > st.currentSeg.maxEv) st.currentSeg.maxEv = deltaTok;
  }
  st.eventCount++;
  if (!evt || evt.delta !== false) tick(st);
  else if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st));
}

export function handleEvent(payload, st, receivedAt) {
  if (!st || !st.active) return;

  var evt = null;
  try { evt = JSON.parse(payload); } catch (e) { return; }
  if (!evt || typeof evt !== "object") return;
  st.eventAt = typeof receivedAt === "number" ? receivedAt : now();
  debugLogEvent(evt);
  var _prevAt = st.lastEventAt || 0; // 上一次任意事件时刻（回放期判"真静默"用）
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
    if (usage.provider) st.providerUsage = usage.provider; // 本回合真实渠道证据
    st.finalUsage = usage;
  }

  var type = evt.type || evt.event || "message";
  if (type !== "error" && /^(text|reasoning|data|plugin_call|plugin_call_output|turn_usage)$/.test(type)) {
    st.pendingError = "";
    if (st.endCause === "error_frame") st.endCause = "";
  }
  if (type === "error") {
    // 流内 error 帧不再当即判死。改成挂起 + 心跳延迟判定：
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

  // 后端补发窗口结束的显式信号。已判中途接入时，有它就不用等 1.5s 静默启发式。
  // 尚未判接入时不关探测：本轮可能只是"补发量小、还没到判定阈值"，让探测继续跑
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

  // reasoning：完全并入统计（建段、计速度、计峰值；与计费口径一致）。
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

  // 工具调用参数帧（type:"data" + delta:true + data.call_id / data.name / data.arguments 分片）。
  // 后端 completion_tokens 含这块，单列统计（toolTokens），不进正文 tokenCount/分段/速度。
  // 回放补发期（中途接入）的参数帧与正文一样剔除，不污染实时数。
  if (type === "data" && evt.delta === true && evt.data
      && typeof evt.data.arguments === "string" && evt.data.arguments) {
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
    if (!st.tFirst) { st.tFirst = _argT; st.ttft = _argT - st.t0; }
    if (!st.liveStartT) st.liveStartT = _argT;
    if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st));
    return;
  }
  // plugin_call / plugin_call_output：工具起止边界帧。拿它们做语义分段——
  // 旧版靠 ">2s 静默" 猜段，而实测 62.5% 的工具循环静默 <2s，整轮被算成一段
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
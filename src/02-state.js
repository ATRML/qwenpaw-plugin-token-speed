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
      // v1.14.1：原始峰值（不做冲刷剔除，诊断 + "峰值≥平均"兜底）/ 被跳过的疑似冲刷数 /
      // 本片输出与上一片的间隔（判"静默之后砸下来的一大坨"用）
      peakRaw: 0, flushSkipped: 0, lastGapMs: 0,
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

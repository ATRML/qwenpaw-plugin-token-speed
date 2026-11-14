  // ════════════════════════════════════════════════════════════
  // 13-ui-bar.js · 悬浮条渲染（等待/生成中/回放/结果四态）
  // ════════════════════════════════════════════════════════════
  // ---------- 渲染（bar：实时态/完成态/空态） ----------

  // v1.7.0：中途接入口径说明只留在 hover title 里；条上与面板上的正文一律压到最短
  // （用户反馈：那段长说明太占地方，正文本该是给你的眼，细节想要时再 hover）
  var ATTACH_TIP = "中途接入：切到会话时后端补发的历史生成内容，其速率无参考价值，"
    + "已从速度 / 峰值 / 分段中剔除；回放量仍计入总量与费用";

  function buildWaitingHtml() {
    return barState("连接中") + '<span class="qp-ts-label">等待首字到达…</span>';
  }

  // v1.8.0：渠道文案（面板 chip + hover 说明）。AFP 是黑话，正文一律说人话
  function channelLabel(ch) {
    if (ch === "afp") return "方舟套餐";
    if (ch === "coding") return "Coding Plan";
    if (ch === "deepseek") return "DeepSeek 官方";
    if (ch === "other") return "其他渠道";
    return "未识别";
  }
  function channelTip(ch, provider) {
    var head = "计费渠道：" + channelLabel(ch) + (provider ? "（" + provider + "）" : "") + "。";
    if (ch === "afp") return head + "走火山方舟 Agent Plan 套餐，按 AFP 点数抵扣——同一个模型名在 DeepSeek 官方是按量付费，两者互斥，所以只能按渠道判";
    if (ch === "coding") return head + "走火山方舟 Coding Plan（地址 /api/coding/v3），按请求次数计、不是 token/AFP，个人版无公开用量 API → 本插件只报 token，不报金额";
    if (ch === "deepseek") return head + "走 DeepSeek 官方 API，按人民币计价（尖峰/低谷单价不同）";
    if (ch === "other") return head + "既不是方舟套餐也不是 DeepSeek 官方，本插件没有该渠道价表 → 只报 token，不报金额";
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
  function buildRunningHtml(x) {
    if (x.replaying) return barState("回放中", ATTACH_TIP) + barItem("已恢复", fmtNum(x.replayTokens || 0) + " tok") + '<span class="qp-ts-more">详情 ↗</span>';
    return barState(x.attached ? "已接入" : "生成中", x.attached ? ATTACH_TIP + "；回放 " + fmtNum(x.replayTokens || 0) + " tok" : "实时估算，结束后由后端用量校准") +
      barItem("速度", fmtSpeed(x.speed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed") +
      barItem("输出", (x.tokenSource === "estimate" ? "≈" : "") + fmtNum(x.tokens) + '<small class="qp-ts-unit">tok</small>') +
      (x.pauseSec > .5 ? barItem("等待", fmtSec(x.pauseSec), "qp-ts-extra") : !x.attached ? barItem("首字", fmtMs(x.ttft), "qp-ts-extra") : '') +
      '<span class="qp-ts-more">详情 ↗</span>';
  }
  function buildResultHtml(r) {
    var info = statusInfo(r, false);
    var total = r.outputTokens != null ? r.outputTokens : r.attached && r.totalGenerated ? r.totalGenerated : (r.tokens || 0) + (r.toolTokens || 0);
    var html = barState(r.attached ? "已接入" : info.text, info.tip + (r.attached ? "；" + ATTACH_TIP + "；回放 " + fmtNum(r.replayTokens || 0) + " tok" : ""));
    if (r.genSpeed > 0 && !r.historyOnly) html += barItem("生成", fmtSpeed(r.genSpeed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed");
    html += barItem("输出", (r.tokenSource === "estimate" ? "≈" : "") + fmtNum(total) + '<small class="qp-ts-unit">tok</small>', '', "本轮输出总量，含正文、思考和工具参数");
    if (r.secondsKnown !== false && r.seconds != null) html += barItem(r.originKnown === false ? "观察" : "耗时", fmtSec(r.seconds), "qp-ts-extra");
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

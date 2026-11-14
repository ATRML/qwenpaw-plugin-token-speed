  // ════════════════════════════════════════════════════════════
  // 14-ui-panel.js · 详情面板（大折线图 / 分段增量表 / 600ms 实时刷新）
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
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>' +
        '<text x="' + (PL - 6) + '" y="' + gy + '" fill="#8fa4c2" font-size="10" text-anchor="end" dominant-baseline="middle">' + label + "</text>";
    });
    // X 轴段号（首、尾，段多时加中点）
    var axis = '<text x="' + x(0) + '" y="' + (H - 8) + '" fill="#8fa4c2" font-size="10" text-anchor="middle">' + sourceIndices[0] + '</text>' +
      '<text x="' + x(n - 1) + '" y="' + (H - 8) + '" fill="#8fa4c2" font-size="10" text-anchor="middle">' + sourceIndices[n - 1] + "</text>";
    if (n >= 6) {
      var mid = Math.floor((n - 1) / 2);
      axis += '<text x="' + x(mid) + '" y="' + (H - 8) + '" fill="#8fa4c2" font-size="10" text-anchor="middle">' + sourceIndices[mid] + "</text>";
    }
    // 折线 + 每段数据点（悬浮 title 提示该段明细）
    var dots = pts.map(function (p, i) {
      var s = segs[i];
      var tip = "段" + sourceIndices[i] + "：总量 " + Math.round(s.tokens) + " tok；测速增量 " + Math.round(measuredSegTokens(s))
        + " tok / " + ((s.t1 - s.t0) / 1000).toFixed(1) + "s = " + speeds[i].toFixed(1) + " tok/s（排除首包和缓冲冲刷）";
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (i === n - 1 ? 3.5 : 2.5) +
        '" fill="' + (i === n - 1 ? "#98edda" : "rgba(130,180,255,0.85)") + '"><title>' + tip + "</title></circle>";
    }).join("");
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="各有效分段生成速度趋势，单位 tok/s">' + grid +
      '<path d="' + path + '" stroke="rgba(130,180,255,0.7)" stroke-width="1.5" fill="none"/>' + dots + axis + "</svg>";
  }

  // 详情面板头部 HTML（title/说明/chips/折线图/分段标题；传入 result 或"活 state 快照"）
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
      : row("费用", fmtMoney(r.cost, "¥"), channelTip(r.channel, r.provider));
    if (r.coefRange && r.afpLo != null) usage += row("套餐抵扣 · 参考", fmtPlanRange({lo:r.afpLo,hi:r.afpHi}), ALIAS_TIP);
    if (r.coefMissing || r.priceMissing || !r.channel) usage += row("计费", r.coefMissing ? "系数未知" : r.priceMissing ? "无价表" : "渠道未识别", channelTip(r.channel,r.provider));
    var observed = !r.historyOnly && speed > 0;
    var speedNote = r.historyOnly ? "历史仅恢复用量，未观测生成速度" : r.attached ? "仅统计接入后有效生成，回放不计速" : "排除首字、工具等待及缓冲冲刷";
    var html = '<div class="qp-d-title"><div><div class="qp-d-eyebrow">TOKEN SPEED</div><div class="qp-d-heading" id="qp-d-heading">本轮生成概览</div><div class="qp-d-meta">' + escHtml(r.model || "未知模型") + (r.aliasModel ? " · Auto" : "") + ' · ' + channelLabel(r.channel) + (fmtAge(r) ? ' · ' + fmtAge(r) : '') + '</div></div><div class="qp-d-tools"><span class="qp-d-badge ' + escHtml(r.status) + '" title="' + escHtml(info.tip) + '">' + info.text + '</span><button type="button" class="qp-d-close" id="qp-d-close" aria-label="关闭生成详情">×</button></div></div>' + note +
      '<div class="qp-d-hero"><div class="qp-d-card speed"><div class="qp-d-label">' + (running ? '实时生成速度' : '有效生成速度') + '<span class="qp-d-tag">' + (r.historyOnly ? '未观测' : '观测估算') + '</span></div><div class="qp-d-number">' + (observed ? fmtSpeed(speed) : '—') + '<small>tok/s</small></div><div class="qp-d-caption">' + speedNote + '</div></div><div class="qp-d-card"><div class="qp-d-label">本轮输出<span class="qp-d-tag">' + (estimated ? '估算' : '后端用量') + '</span></div><div class="qp-d-number" title="' + Math.round(total).toLocaleString('zh-CN') + ' tok">' + (estimated ? '≈' : '') + fmtNum(total) + '<small>tok</small></div><div class="qp-d-caption">含正文、思考与工具参数</div></div></div>' +
      '<div class="qp-d-timings">' + time("首字等待", r.attached || r.historyOnly ? '—' : fmtMs(r.ttft), "从提交请求到首个输出到达") +
      time("工具 / 空闲等待", waitValue(r.pauseSec), "已观测工具执行与段间空闲等待") + time("工具后模型等待", waitValue(r.modelWaitSec), "工具结束到下一次正文或思考到达，单列记录") +
      time(r.originKnown === false ? "接入后观察" : "总耗时", r.secondsKnown === false || r.seconds == null ? '—' : fmtSec(r.seconds), "从请求开始到结束；中途接入时为已观测时长") + '</div>' +
      '<div class="qp-d-section">用量与计费<small>拆分项已包含在总量内</small></div><div class="qp-d-usage">' + usage + '</div>' +
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
      // v1.14.1：不变量——峰值不可能低于平均（与 endTurn 同款兜底）
      peak: st.peakMax || 0,
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
      document.addEventListener("click", onDocClickDetail, true);
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

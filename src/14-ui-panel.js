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
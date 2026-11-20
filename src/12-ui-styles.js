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
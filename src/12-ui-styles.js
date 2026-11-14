  // Token Speed 1.17 · scoped visual system
  var styles = `
    #qp-token-speed-bar, #qp-token-speed-detail { box-sizing:border-box; font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; font-variant-numeric:tabular-nums; color:#edf3ff; line-height:1.5; }
    #qp-token-speed-bar { position:fixed; z-index:50; display:flex; align-items:center; gap:16px; width:max-content; max-width:calc(100vw - 24px); padding:9px 12px 9px 16px; border-radius:16px; border:1px solid #ffffff22; background:rgba(19,26,43,.96); box-shadow:0 8px 28px #0005; cursor:pointer; user-select:none; font-size:12px; white-space:nowrap; backdrop-filter:blur(18px); }
    #qp-token-speed-bar:hover { border-color:#86b7ff66; background:#1c2940; }
    #qp-token-speed-bar:focus-visible { outline:2px solid #9bc1ff; outline-offset:3px; }
    #qp-token-speed-bar .qp-ts-state { display:inline-flex; align-items:center; gap:7px; color:#bcc9df; font-size:11px; }
    #qp-token-speed-bar .qp-ts-dot { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:#8d9bb4; }
    #qp-token-speed-bar.done .qp-ts-dot { background:#93b9ff; }
    #qp-token-speed-bar.running .qp-ts-dot { background:#6ce0c2; animation:qp-ts-pulse 1.6s infinite; }
    #qp-token-speed-bar.abort .qp-ts-dot, #qp-token-speed-bar.error .qp-ts-dot { background:#ffbb86; }
    #qp-token-speed-bar .qp-ts-item { display:inline-flex; align-items:baseline; gap:6px; }
    #qp-token-speed-bar .qp-ts-label { color:#aab8ce; font-size:11px; }
    #qp-token-speed-bar .qp-ts-val { font-weight:600; color:#f2f6ff; }
    #qp-token-speed-bar .qp-ts-speed .qp-ts-val { color:#91e8d4; font-size:18px; letter-spacing:-.4px; }
    #qp-token-speed-bar .qp-ts-unit { color:#aab8ce; font-size:10px; font-weight:400; margin-left:3px; }
    #qp-token-speed-bar .qp-ts-more { padding:4px 8px; border-radius:8px; color:#d7e6ff; background:#ffffff0c; font-size:11px; }
    #qp-token-speed-bar .qp-ts-extra { border-left:1px solid #ffffff18; padding-left:14px; }
    @keyframes qp-ts-pulse { 50% { opacity:.4; } }
    #qp-token-speed-detail { position:fixed; z-index:100; top:50%; left:50%; transform:translate(-50%,-50%); width:700px; max-width:calc(100vw - 32px); max-height:calc(100dvh - 48px); overflow:auto; padding:26px; border-radius:24px; border:1px solid #ffffff26; background:#141e30; box-shadow:0 24px 100px #0009; font-size:13px; scrollbar-width:thin; scrollbar-color:#42516c transparent; }
    #qp-token-speed-detail * { box-sizing:border-box; }
    #qp-token-speed-detail .qp-d-title { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:22px; }
    #qp-token-speed-detail .qp-d-eyebrow { color:#9bb5db; letter-spacing:1.6px; font-size:10px; font-weight:600; margin-bottom:4px; }
    #qp-token-speed-detail .qp-d-heading { font-size:21px; font-weight:650; letter-spacing:-.4px; }
    #qp-token-speed-detail .qp-d-meta { margin-top:6px; color:#9eadc5; font-size:12px; overflow-wrap:anywhere; }
    #qp-token-speed-detail .qp-d-tools { display:flex; align-items:center; gap:12px; flex-shrink:0; }
    #qp-token-speed-detail .qp-d-badge { display:inline-flex; align-items:center; gap:6px; color:#a8ecd9; background:#79dbb810; border:1px solid #79dbb82a; border-radius:7px; padding:3px 8px; font-size:11px; }
    #qp-token-speed-detail .qp-d-badge.abort, #qp-token-speed-detail .qp-d-badge.error { color:#ffd4a8; background:#ffc28112; border-color:#ffc28130; }
    #qp-token-speed-detail .qp-d-close { display:grid; place-items:center; width:30px; height:30px; border:1px solid #ffffff12; border-radius:9px; background:#ffffff05; color:#aebbd1; cursor:pointer; font-size:16px; line-height:1; }
    #qp-token-speed-detail .qp-d-close:hover { color:white; background:#ffffff14; }
    #qp-token-speed-detail button:focus-visible { outline:2px solid #9bc1ff; outline-offset:2px; }
    #qp-token-speed-detail .qp-d-hero { display:grid; grid-template-columns:1.1fr 1fr; gap:12px; margin-bottom:12px; }
    #qp-token-speed-detail .qp-d-card { padding:19px 20px 16px; background:#ffffff04; border:1px solid #ffffff12; border-radius:16px; min-width:0; }
    #qp-token-speed-detail .qp-d-card.speed { background:linear-gradient(125deg,#254d5645,#1d324215); border-color:#82e2cf36; }
    #qp-token-speed-detail .qp-d-label { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#b6c5db; font-size:12px; }
    #qp-token-speed-detail .qp-d-tag { padding:1px 5px; color:#a8c4ec; border:1px solid #8daedc35; border-radius:4px; font-size:10px; white-space:nowrap; }
    #qp-token-speed-detail .qp-d-number { display:flex; align-items:baseline; gap:7px; margin:6px 0 4px; font-size:38px; font-weight:600; letter-spacing:-1.4px; line-height:1.35; color:#f3f7ff; }
    #qp-token-speed-detail .speed .qp-d-number { color:#98edda; }
    #qp-token-speed-detail .qp-d-number small { font-size:12px; font-weight:400; letter-spacing:0; color:#9fadc3; }
    #qp-token-speed-detail .qp-d-caption { color:#98a9c1; font-size:11px; line-height:1.6; }
    #qp-token-speed-detail .qp-d-timings { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid #ffffff12; border-radius:13px; padding:14px 0; margin-bottom:22px; background:#0c142320; }
    #qp-token-speed-detail .qp-d-time { padding:0 14px; border-left:1px solid #ffffff10; }
    #qp-token-speed-detail .qp-d-time:first-child { border-left:0; }
    #qp-token-speed-detail .qp-d-time span { display:block; color:#99abc4; font-size:11px; }
    #qp-token-speed-detail .qp-d-time strong { display:block; margin-top:5px; font-size:17px; font-weight:550; color:#e3ecfb; }
    #qp-token-speed-detail .qp-d-section { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 10px; font-size:12px; font-weight:600; color:#d8e4f7; }
    #qp-token-speed-detail .qp-d-section small { font-size:10px; color:#859ab8; font-weight:400; }
    #qp-token-speed-detail .qp-d-usage { display:grid; grid-template-columns:1fr 1fr; gap:0 26px; padding:2px 0 16px; }
    #qp-token-speed-detail .qp-c { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:7px 0; min-width:0; }
    #qp-token-speed-detail .qp-cl { color:#98abc5; font-size:12px; }
    #qp-token-speed-detail .qp-cv { text-align:right; color:#e0eafd; font-size:12px; overflow-wrap:anywhere; }
    #qp-token-speed-detail .qp-d-explain { color:#91a4c0; font-size:11px; line-height:1.7; border-top:1px solid #ffffff12; padding-top:12px; margin-bottom:20px; }
    #qp-token-speed-detail .qp-d-note { font-size:11px; color:#f6ce9e; background:#e9a55e0b; border:1px solid #dba66d2a; border-radius:9px; padding:8px 11px; margin-bottom:12px; line-height:1.6; }
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
    @media(max-width:600px) {
      #qp-token-speed-bar { gap:10px; padding:8px 10px; border-radius:12px; }
      #qp-token-speed-bar .qp-ts-extra { display:none; }
      #qp-token-speed-bar .qp-ts-speed .qp-ts-val { font-size:16px; }
      #qp-token-speed-bar .qp-ts-state { font-size:10px; }
      #qp-token-speed-detail { max-width:calc(100vw - 20px); max-height:calc(100dvh - 24px); padding:18px; border-radius:19px; }
      #qp-token-speed-detail .qp-d-heading { font-size:19px; }
      #qp-token-speed-detail .qp-d-title { margin-bottom:16px; gap:8px; }
      #qp-token-speed-detail .qp-d-tools { gap:6px; }
      #qp-token-speed-detail .qp-d-hero { gap:8px; }
      #qp-token-speed-detail .qp-d-card { padding:14px 12px; }
      #qp-token-speed-detail .qp-d-number { font-size:29px; gap:4px; }
      #qp-token-speed-detail .qp-d-number small { font-size:10px; }
      #qp-token-speed-detail .qp-d-label { font-size:11px; flex-wrap:wrap; gap:4px; }
      #qp-token-speed-detail .qp-d-timings { grid-template-columns:1fr 1fr; row-gap:14px; }
      #qp-token-speed-detail .qp-d-time:nth-child(3) { border-left:0; }
      #qp-token-speed-detail .qp-d-usage { grid-template-columns:1fr; }
    }
    @media(prefers-reduced-motion:reduce) { #qp-token-speed-bar.running .qp-ts-dot { animation:none; } }
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

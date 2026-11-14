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
  function init() {
    injectStyles();
    injectBar();
    installRouteTracking();
    refreshActiveLlm(false); // v1.8.0：尽早拿真实渠道/模型（并修正旧版结果里错的金额）

    var lastSession = getSessionId();
    var slowTick = 0;
    setInterval(function () {
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
        refreshBarContent();
        return;
      }

      // 3) 位置校正 + 存活维护
      positionBar();
      if (!document.getElementById(BAR_ID)) injectBar();

      // 4) 低频（3s 一次）：disclaimer 隐藏维护
      if (slowTick % 3 === 0) hideAnchor();
    }, 1000);

    var observer = new MutationObserver(function () {
      if (!document.getElementById(BAR_ID)) injectBar();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 20000);
  }

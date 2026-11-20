// 初始化与 1s 主循环（停顿补测 / error 帧延迟判定，原 16-init）
// 子系统各自隔离——样式/挂载/路由/渠道任何一个失败都不拖垮统计主循环。
import { store } from "./store.js";
import { renderer } from "./renderer.js";
import { BAR_ID } from "./constants.js";
import { now } from "./utils.js";
import { getSessionId } from "./session.js";
import { closeCurrentSeg } from "./state.js";
import { runningView } from "./metrics.js";
import { finishAbnormal } from "./stream.js";
import { refreshActiveLlm } from "./channel.js";
import { injectStyles } from "./ui-styles.js";
import { injectBar, installRouteTracking, positionBar, resetAnchorScan, hideAnchor } from "./ui-mount.js";

// v1.15.0: one cursor for idle accounting; never overwrite the last body timestamp.
export function maintainStream(st, t) {
  if (st.active && !(st.attached && !st.replayDone) && (st.toolPending || st.toolResumeAt)) {
    if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st, {speed: 0}));
    return;
  }
  if (!st.active || (st.attached && !st.replayDone) || st.toolPending || !st.tLast || t - st.tLast <= 2000) return;
  closeCurrentSeg(st);
  st.pauseMs += Math.max(0, t - Math.max(st.tLast, st.idleAccountedUntil || 0));
  st.idleAccountedUntil = t;
  st.lastSpeed = 0; st.window = []; st.evWin = [];
  if (st.__sid === getSessionId()) renderer.renderRunning(runningView(st, {speed: 0}));
}

// ---------- 初始化 ----------
export function init() {
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
      Object.keys(store.states).forEach(function (sid) {
        var st = store.states[sid];
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
        renderer.refreshBarContent();
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
// 生命周期测试入口（带真实渲染总线 + DOM 挂载函数）。
// 与 entry.js 的区别：不置空 renderer，暴露 init / 挂载 / 面板 / 路由函数，供 DOM mock 驱动。
// 同样不自动跑 init / patchFetch —— 测试自行调用。
import { store } from "../src/store.js";
import { renderer } from "../src/renderer.js";
import { BAR_ID, PANEL_ID, DONE } from "../src/constants.js";
import { getSessionId } from "../src/session.js";
import { getState, getActiveStream } from "../src/state.js";
import { startTurn, handleEvent } from "../src/turn.js";
import { endTurn, runningView } from "../src/metrics.js";
import { patchFetch, monitorStream, finishAbnormal, hydrateChatHistory, applyBillingRetro } from "../src/stream.js";
import { resolveChannel } from "../src/channel.js";
import { moneyFields } from "../src/pricing.js";
import { saveLastResult, loadLastResult } from "../src/persistence.js";
import { init, maintainStream } from "../src/init.js";
import { injectStyles } from "../src/ui-styles.js";
import {
  injectBar, positionBar, hideAnchor, resetAnchorScan, refreshBarContent, installRouteTracking, isOnChatPage
} from "../src/ui-mount.js";
import { openDetail, closeDetail, onBarClick, refreshDetail, liveSnapshot, buildDetailHead } from "../src/ui-panel.js";
import { buildRunningHtml, buildResultHtml, buildWaitingHtml } from "../src/ui-bar.js";

store.testMode = true; // 禁用后台渠道刷新；测试用 setChannelConfig 设定渠道

window.testApi = {
  store, renderer, BAR_ID, PANEL_ID, DONE,
  getSessionId, getState, getActiveStream, startTurn, handleEvent, endTurn, runningView,
  patchFetch, monitorStream, finishAbnormal, hydrateHistory: hydrateChatHistory, applyBillingRetro,
  resolveChannel, moneyFields, saveLastResult, loadLastResult,
  init, maintainStream, injectStyles,
  injectBar, positionBar, hideAnchor, resetAnchorScan, refreshBarContent, installRouteTracking, isOnChatPage,
  openDetail, closeDetail, onBarClick, refreshDetail, liveSnapshot, buildDetailHead,
  buildRunningHtml, buildResultHtml, buildWaitingHtml,
  setChannelConfig: function (config, map) { store.activeLlm = config; store.providerMap = map || {}; }
};
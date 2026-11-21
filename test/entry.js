// 测试专用入口（不进生产 dist/index.js）。
// 导入引擎 + UI 构建器，把渲染总线置为 noop（无头环境不碰 DOM），暴露 window.testApi。
// 不调用 patchFetch / init —— 回归测试自行驱动 startTurn/handleEvent/endTurn/monitorStream。
import { store } from "../src/store.js";
import { renderer } from "../src/renderer.js";
import { getSessionId } from "../src/session.js";
import { getState } from "../src/state.js";
import { startTurn, handleEvent } from "../src/turn.js";
import { endTurn, runningView, burnRateOf } from "../src/metrics.js";
import { patchFetch, monitorStream, finishAbnormal, hydrateChatHistory, applyBillingRetro } from "../src/stream.js";
import { extractUsage, ratioFor } from "../src/tokens.js";
import { resolveChannel } from "../src/channel.js";
import {
  calcTokenPlan, calcTokenPlanRange, tokenplanEntryFor, tpNightActive, beijingHour, calcDashscope, moneyFields,
  calcUsd, usdEntryFor, isUsdChannel, costUnitFor, channelHasPriceTable
} from "../src/pricing.js";
import { PRICING, TP_PLANS } from "../src/pricing-data.js";
import { appendLedger, ledgerToday, loadLedger } from "../src/ledger.js";
import { saveLastResult, loadLastResult } from "../src/persistence.js";
import { maintainStream } from "../src/init.js";
import { buildRunningHtml, costChipHtml } from "../src/ui-bar.js";
import { liveSnapshot, syncSegs, buildDetailChart, segRowHtml, buildDetailHead } from "../src/ui-panel.js";

// 无头 seam：渲染总线全部置空，引擎调用渲染时静默降级（与生产 UI 失败时的降级路径一致）
store.testMode = true; // 禁用 refreshActiveLlm 后台刷新（测试自行用 setChannelConfig 设定渠道）
renderer.renderRunning = function () {};
renderer.renderReplay = function () {};
renderer.renderDone = function () {};
renderer.renderWaiting = function () {};
renderer.refreshDetail = function () {};
renderer.refreshBarContent = function () {};

window.testApi = {
  getSessionId, getState, startTurn, handleEvent, endTurn, finishAbnormal,
  patchFetch, monitorStream, runningView, liveSnapshot, extractUsage,
  states: store.states, ratioFor, syncSegs, buildDetailChart, segRowHtml,
  hydrateHistory: hydrateChatHistory,
  applyBillingRetro,
  setChannelConfig: function (config, map) { store.activeLlm = config; store.providerMap = map || {}; },
  maintain: maintainStream,
  resolveChannel, calcTokenPlan, calcTokenPlanRange, tokenplanEntryFor, tpNightActive, beijingHour,
  calcDashscope, moneyFields, burnRateOf, PRICING, TP_PLANS,
  calcUsd, usdEntryFor, isUsdChannel, costUnitFor, channelHasPriceTable,
  appendLedger, ledgerToday, loadLedger, saveLastResult, loadLastResult,
  buildDetailHead, buildRunningHtml, costChipHtml,
  renderer
};
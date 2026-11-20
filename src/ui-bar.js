// 悬浮条渲染（等待/生成中/回放/结果四态）+ 渠道文案（原 13-ui-bar）
// 仪表化重设计：状态·模型·速度·输出·费用 chip·详情，一眼读完本轮经济账。
// 真实渲染实现注入 renderer 总线，供引擎调用。
import { BAR_ID, DONE, RENDER_MIN_GAP } from "./constants.js";
import { renderer } from "./renderer.js";
import { now, fmtNum, fmtSpeed, fmtSec, fmtMs, fmtMoney, fmtPlan, fmtCredits, creditsToCny, escHtml } from "./utils.js";
import { fmtPlanRange } from "./pricing.js";
import { getSessionId } from "./session.js";

// 中途接入口径说明只留在 hover title 里；条上与面板上的正文一律压到最短
export var ATTACH_TIP = "中途接入：切到会话时后端补发的历史生成内容，其速率无参考价值，"
  + "已从速度 / 峰值 / 分段中剔除；回放量仍计入总量与费用";

export function buildWaitingHtml() {
  return barState("连接中") + '<span class="qp-ts-label">等待首字到达…</span>';
}

// 渠道文案（面板 chip + hover 说明），正文一律说人话；代号 plan（旧值 afp 兼容显示）
export function channelLabel(ch) {
  if (ch === "plan" || ch === "afp") return "套餐渠道";
  if (ch === "coding") return "Coding Plan";
  if (ch === "deepseek") return "DeepSeek 官方";
  if (ch === "tokenplan") return "百炼 Token Plan";
  if (ch === "dashscope") return "百炼按量";
  if (ch === "other") return "其他渠道";
  return "未识别";
}
export function channelTip(ch, provider) {
  var head = "计费渠道：" + channelLabel(ch) + (provider ? "（" + provider + "）" : "") + "。";
  if (ch === "plan" || ch === "afp") return head + "走套餐（Agent Plan）渠道，按套餐额度抵扣——同一个模型名在按量渠道是人民币计费，两边计费方式互斥，所以只能按渠道判";
  if (ch === "coding") return head + "走 Coding Plan 渠道（地址 /api/coding/v3 或 coding.dashscope.aliyuncs.com），按请求次数计、不是 token/额度，个人版无公开用量 API → 本插件只报 token，不报金额";
  if (ch === "deepseek") return head + "走 DeepSeek 官方 API，按人民币计价（尖峰/低谷单价不同）";
  if (ch === "tokenplan") return head + "走阿里云百炼 Token Plan，按 Credits 抵扣：credits/万tok 的数值 = 官方刊例价 元/百万tok（1 credit = 0.01 元刊例价）。北京时间 22:00–08:00 部分模型享官方夜间折扣（qwen3.8 系 4 折 / deepseek-v4 系 5 折），qwen4-max-preview 预览期另有 2 折；plus/flash 系按输入 token 阶梯计价";
  if (ch === "dashscope") return head + "走阿里云百炼按量付费，人民币刊例价计价（DeepSeek 系模型分忙/闲时，忙 08:00–22:00 北京）；与 Token Plan 的 Credits 额度相互独立、不互通";
  if (ch === "other") return head + "不是套餐/DeepSeek 官方这类内置价目渠道，本插件没有该渠道价表 → 只报 token，不报金额（可在覆盖层配 generic 价目）";
  return head + "拿不到 provider 信息（usage.provider_id 为空、/api/models/active 也读不到）→ 只报 token，不报金额。宁可空着，也不按模型名猜一个错数";
}

// 状态文案 + hover 说明（过去"莫名其妙的出错"就是这里看不见原因）
export function statusInfo(r, running) {
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
// 费用 chip：credits 金色 ◈ / 人民币 ¥ / 套餐 ▣。算不出钱就不显示（宁可空着不猜）。
export function costChipHtml(r) {
  if (!r) return "";
  if (r.cost != null && r.costUnit === "credits") {
    return '<span class="qp-ts-item qp-ts-cost credits" title="本轮 Credits 消耗（百炼 Token Plan）≈' + escHtml(fmtMoney(creditsToCny(r.cost), "¥")) + ' 刊例价"><span class="qp-ts-val">◈ ' + fmtCredits(r.cost) + '</span></span>';
  }
  if (r.cost != null && r.costUnit === "plan") {
    return '<span class="qp-ts-item qp-ts-cost plan" title="套餐抵扣 ' + escHtml(fmtMoney(r.cost, "")) + ' 额度"><span class="qp-ts-val">▣ ' + fmtMoney(r.cost, "") + '</span></span>';
  }
  if (r.cost != null) {
    return '<span class="qp-ts-item qp-ts-cost cny" title="本轮费用（人民币）"><span class="qp-ts-val">' + fmtMoney(r.cost, "¥") + '</span></span>';
  }
  if (r.afp != null && r.afp > 0) {
    return '<span class="qp-ts-item qp-ts-cost plan" title="套餐抵扣 ' + escHtml(fmtPlan(r.afp)) + ' 额度"><span class="qp-ts-val">▣ ' + fmtPlan(r.afp) + '</span></span>';
  }
  if (r.coefRange && r.afpLo != null) {
    return '<span class="qp-ts-item qp-ts-cost plan" title="Auto 路由活动期外：套餐抵扣参考区间"><span class="qp-ts-val">▣ ' + fmtPlanRange({ lo: r.afpLo, hi: r.afpHi }) + '</span></span>';
  }
  if (r.tpRange && r.tpLo != null) {
    return '<span class="qp-ts-item qp-ts-cost credits" title="auto 路由：全表当前时刻 Credits 参考区间"><span class="qp-ts-val">◈ ' + fmtCredits(r.tpLo) + '~' + fmtCredits(r.tpHi) + '</span></span>';
  }
  return "";
}
// 模型名短标（截断由 CSS 负责，hover 看全名）
function barModelHtml(model) {
  if (!model) return "";
  return '<span class="qp-ts-model" title="' + escHtml(model) + '">' + escHtml(model) + '</span>';
}
export function buildRunningHtml(x) {
  if (x.replaying) return barState("回放中", ATTACH_TIP) + barItem("已恢复", fmtNum(x.replayTokens || 0) + " tok") + '<span class="qp-ts-more">详情 ↗</span>';
  return barState(x.attached ? "已接入" : "生成中", x.attached ? ATTACH_TIP + "；回放 " + fmtNum(x.replayTokens || 0) + " tok" : "实时估算，结束后由后端用量校准") +
    barModelHtml(x.model) +
    barItem("速度", fmtSpeed(x.speed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed") +
    barItem("输出", (x.tokenSource === "estimate" ? "≈" : "") + fmtNum(x.tokens) + '<small class="qp-ts-unit">tok</small>') +
    (x.pauseSec > .5 ? barItem("等待", fmtSec(x.pauseSec), "qp-ts-extra") : !x.attached ? barItem("首字", fmtMs(x.ttft), "qp-ts-extra") : '') +
    costChipHtml(x) +
    '<span class="qp-ts-more">详情 ↗</span>';
}
export function buildResultHtml(r) {
  var info = statusInfo(r, false);
  var total = r.outputTokens != null ? r.outputTokens : r.attached && r.totalGenerated ? r.totalGenerated : (r.tokens || 0) + (r.toolTokens || 0);
  var html = barState(r.attached ? "已接入" : info.text, info.tip + (r.attached ? "；" + ATTACH_TIP + "；回放 " + fmtNum(r.replayTokens || 0) + " tok" : ""));
  html += barModelHtml(r.model);
  if (r.genSpeed > 0 && !r.historyOnly) html += barItem("生成", fmtSpeed(r.genSpeed) + '<small class="qp-ts-unit">tok/s</small>', "qp-ts-speed");
  html += barItem("输出", (r.tokenSource === "estimate" ? "≈" : "") + fmtNum(total) + '<small class="qp-ts-unit">tok</small>', '', "本轮输出总量，含正文、思考和工具参数");
  if (r.secondsKnown !== false && r.seconds != null) html += barItem(r.originKnown === false ? "观察" : "耗时", fmtSec(r.seconds), "qp-ts-extra");
  html += costChipHtml(r);
  return html + '<span class="qp-ts-more">详情 ↗</span>';
}

function setBar(cls, html) {
  var bar = document.getElementById(BAR_ID);
  if (!bar) return;
  bar.className = cls;
  bar.innerHTML = html;
}

var lastRunRender = 0;
export function renderRunning(x) {
  var t = now();
  if (t - lastRunRender < RENDER_MIN_GAP) return;
  lastRunRender = t;
  setBar("running", buildRunningHtml(x));
}
// 回放态渲染（回放期间 addDelta 直接 return，不会走到 tick，故单独入口）
export function renderReplay(st) {
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

export function renderDone(r) {
  setBar(r.status === DONE ? "done" : r.status, buildResultHtml(r));
  // 面板开着就地把内容刷成终态（不再重建元素 → 不闪、不丢滚动位置）
  renderer.refreshDetail(r);
}
export function renderWaiting() {
  setBar("running", buildWaitingHtml());
}

// 注入渲染总线：引擎经此调用悬浮条渲染
renderer.renderRunning = renderRunning;
renderer.renderReplay = renderReplay;
renderer.renderDone = renderDone;
renderer.renderWaiting = renderWaiting;
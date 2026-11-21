// 计费渠道判定（provider 三级证据链 / active_llm / providerMap，原 05-channel）
// 病根（实测反馈："明明用的 DeepSeek，为啥显示套餐抵扣"）：模型名无法决定计费渠道——
// 同一个 deepseek-v4-flash 在套餐渠道与 DeepSeek 官方都在卖。渠道必须按 provider 证据判：
//   provider_id 含 agentplan / base_url 含 /api/plan/  → plan（套餐渠道，按额度抵扣）
//   provider deepseek / base_url 含 deepseek.com       → deepseek（官方按量，人民币）
//   token-plan.*.maas.aliyuncs.com / provider tokenplan → tokenplan（百炼 Credits）
//   dashscope.aliyuncs.com / provider dashscope|bailian → dashscope（百炼按量，人民币）
//   其他/拿不到                                        → other（不显示金额，不猜）
// 共享可变态 activeLlm / providerMap 已移入 store.js。
import { store } from "./store.js";
import { customChannelOf } from "./pricing.js";
import { getCurrentModel } from "./model.js";
import { applyBillingRetro } from "./stream.js";

var ACTIVE_LLM_KEY = "qp_token_speed_active_llm"; // {ts, providerId, model}
var PROVIDER_MAP_KEY = "qp_token_speed_provider_map"; // {ts, map:{providerId: base_url}}
var ACTIVE_LLM_TTL = 20000; // 20s：够快跟上模型/渠道切换，又不至于每回合都请求
var PROVIDER_MAP_TTL = 24 * 3600 * 1000;
// 批量冲刷说明（峰值/速度里剔除过"一大坨一次性砸进来"时挂在面板提示上）
export var FLUSH_TIP = "本回合出现过「批量冲刷」：单个事件一次 >600 tok，且出现在 >1.2s 静默之后（补发尾巴 / 网关缓冲刷出）。"
  + "这类窗口已从峰值与实时速度中剔除——它们衡量的是「数据砸进来的速度」，不是模型解码速度。";

export function providerBaseUrl(pid) {
  if (!pid) return "";
  var hit = store.providerMap[String(pid).toLowerCase()];
  return hit || "";
}

// 渠道判定：只认 provider 证据，拿不到证据返回 ""（而不是默认套餐抵扣——那正是旧 bug）
export function resolveChannel(providerId, baseUrl) {
  var pid = String(providerId || "").toLowerCase();
  var bu = String(baseUrl || "").toLowerCase();
  // 顺序关键：/api/coding 必须在 /api/plan 前判
  if (/\/api\/coding(\/|$)/.test(bu) || /coding[_\-]?plan/.test(pid)) return "coding";
  if (/agentplan|agent-plan|agent_plan/.test(pid) || /\/api\/plan\//.test(bu)) return "plan";
  // 阿里云百炼 Token Plan：专属端点 token-plan.<region>.maas.aliyuncs.com，或 provider 名含 tokenplan。
  // base_url 证据优先——同一个 qwen 模型名在百炼按量/Token Plan/其他渠道都在卖，只认端点不认名字
  if (/token[-_]?plan/.test(pid) || bu.indexOf("token-plan.") >= 0 || bu.indexOf("maas.aliyuncs.com") >= 0) return "tokenplan";
  if (pid === "deepseek" || pid.indexOf("deepseek") >= 0 || bu.indexOf("deepseek.com") >= 0) return "deepseek";
  // 阿里云 Coding Plan 专属端点 coding.dashscope.aliyuncs.com（与 /api/coding 同渠道，不套金额表）
  if (bu.indexOf("coding.dashscope") >= 0) return "coding";
  // 百炼按量付费（dashscope.aliyuncs.com 通用端点 / provider 名含 dashscope|bailian）：人民币刊例价计价
  if (bu.indexOf("dashscope.aliyuncs.com") >= 0 || /dashscope|bailian/.test(pid)) return "dashscope";
  // 通用 USD 渠道：只认 provider/端点证据，不做模型名兜底（避免把第三方转售误判成官方刊例价）。
  // Google 仅认 Gemini API 端点或 gemini provider 名；Vertex（aiplatform）价不同，不在此列。
  if (bu.indexOf("api.openai.com") >= 0 || pid.indexOf("openai") >= 0) return "openai";
  if (bu.indexOf("api.anthropic.com") >= 0 || pid.indexOf("anthropic") >= 0) return "anthropic";
  if (bu.indexOf("generativelanguage.googleapis.com") >= 0 || pid.indexOf("gemini") >= 0) return "google";
  // 自定义渠道映射（纯数据：PRICING.customChannels，可经 localStorage 覆盖层注入）
  var _cc = customChannelOf(pid, bu);
  if (_cc) return _cc;
  if (pid) return "other";
  return "";
}

// 三级证据 → 当前渠道。provHint 是本回合 SSE usage 里的 provider_id（若有）
export function currentChannel(provHint) {
  var model = getCurrentModel();
  var cands = [
    { pid: provHint || "", src: "usage" },
    { pid: (store.activeLlm && store.activeLlm.providerId) || "", src: "active" }
  ];
  for (var i = 0; i < cands.length; i++) {
    if (!cands[i].pid) continue;
    var ch = resolveChannel(cands[i].pid, providerBaseUrl(cands[i].pid));
    if (ch) return { channel: ch, provider: cands[i].pid, src: cands[i].src };
  }
  // 兜底：连 provider 都拿不到时，只在模型名足够明确时才敢判。判不出就留空 → 面板"渠道未识别"，绝不显示金额
  if (/deepseek/i.test(String(model || ""))) return { channel: "deepseek", provider: "", src: "model" };
  return { channel: "", provider: "", src: "" };
}

// 拉当前活跃模型/渠道（GET /api/models/active；鉴权开启时带上 token 与 agent id）
function apiHeaders() {
  var h = { Accept: "application/json" };
  try {
    var t = localStorage.getItem("qwenpaw_auth_token");
    if (t) h["Authorization"] = "Bearer " + t;
    var raw = sessionStorage.getItem("qwenpaw-agent-storage") || localStorage.getItem("qwenpaw-agent-storage");
    if (raw) {
      var j = JSON.parse(raw);
      var aid = j && j.state && j.state.selectedAgent;
      if (aid) h["X-Agent-Id"] = aid;
    }
  } catch (e) { /* ignore */ }
  return h;
}

var llmFetching = false;
export function refreshActiveLlm(force) {
  if (store.testMode) return; // 无头测试 seam：禁用后台渠道刷新，避免污染宿主 fetch（生产永不置位）
  if (typeof fetch !== "function") return;
  if (llmFetching) return;
  var fresh = store.activeLlm && store.activeLlm.ts && Date.now() - store.activeLlm.ts < ACTIVE_LLM_TTL;
  if (fresh && !force) return;
  llmFetching = true;
  try {
    fetch("/api/models/active", { headers: apiHeaders() })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        llmFetching = false;
        var llm = j && j.active_llm;
        if (!llm || (!llm.provider_id && !llm.model)) return;
        store.activeLlm = { ts: Date.now(), providerId: llm.provider_id || "", model: llm.model || "" };
        try { localStorage.setItem(ACTIVE_LLM_KEY, JSON.stringify(store.activeLlm)); } catch (e) { /* ignore */ }
        maybeLoadProviderMap(); // 渠道不能只靠 provider_id 认时才去拉 base_url
        applyBillingRetro();
      })
      .catch(function () { llmFetching = false; });
  } catch (e) { llmFetching = false; }
}

// provider_id 不足以判定渠道（例如自定义 provider）时，拉一次 /api/models 拿 base_url
// （大响应，只拉一次，落 localStorage 缓存 24h）
var mapFetching = false;
export function maybeLoadProviderMap() {
  if (!store.activeLlm || !store.activeLlm.providerId) return;
  // provider_id 本身就能定性就不用去拉 base_url；只有"认不出"的自定义 provider 才需要 base_url 佐证
  var ch0 = resolveChannel(store.activeLlm.providerId, "");
  if (ch0 === "plan" || ch0 === "deepseek" || ch0 === "coding" || ch0 === "tokenplan" || ch0 === "dashscope") return;
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(PROVIDER_MAP_KEY) || "null"); } catch (e) { /* ignore */ }
  if (cached && cached.map && cached.ts && Date.now() - cached.ts < PROVIDER_MAP_TTL) {
    store.providerMap = cached.map;
    return;
  }
  if (mapFetching || typeof fetch !== "function") return;
  mapFetching = true;
  try {
    fetch("/api/models", { headers: apiHeaders() })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        mapFetching = false;
        if (!Array.isArray(j)) return;
        var map = {};
        for (var i = 0; i < j.length; i++) {
          var p = j[i] || {};
          var key = String(p.id || "").toLowerCase();
          if (key) map[key] = p.base_url || "";
        }
        store.providerMap = map;
        try { localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify({ ts: Date.now(), map: map })); } catch (e) { /* ignore */ }
        applyBillingRetro(true); // base_url 证据刚到位：允许 other → plan/deepseek 的升级
      })
      .catch(function () { mapFetching = false; });
  } catch (e) { mapFetching = false; }
}
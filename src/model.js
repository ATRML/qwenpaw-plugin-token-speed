// 模型名获取（active_llm → DOM 兜底）/ completed 全文提取（原 07-model）
import { store } from "./store.js";

// 模型名：usage.model_name 常为空 → 退到 /api/models/active 的真实模型，再退 DOM
export function getCurrentModel() {
  if (store.activeLlm && store.activeLlm.model) return store.activeLlm.model;
  return getDomModel();
}
// SSE 事件里不一定带 model，兜底从顶部 header DOM 读（仅作最后兜底）
export function getDomModel() {
  try {
    var el = document.querySelector(
      ".qwenpaw-chat-anywhere-layout-right-header [class*='triggerName'], [class*='triggerName']"
    );
    if (el && el.textContent.trim()) return el.textContent.trim();
    var hdr = document.querySelector(".qwenpaw-chat-anywhere-layout-right-header");
    if (hdr) {
      var m = hdr.textContent.match(/(deepseek[\w.-]*|glm[\w.-]*|gpt[\w.-]*|claude[\w.-]*|qwen[\w.-]*)/i);
      if (m) return m[1];
    }
  } catch (e) { /* ignore */ }
  return "";
}

// 从 completed message 事件提取完整文本
export function extractFullText(data) {
  if (!data || typeof data !== "object") return "";
  var parts = [];
  function collectContent(o) {
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) collectContent(o[i]);
      return;
    }
    if (o && typeof o === "object") {
      if (typeof o.text === "string") {
        parts.push(o.text);
        return;
      }
      var keys = Object.keys(o);
      for (var j = 0; j < keys.length; j++) {
        if (keys[j] === "text") continue;
        collectContent(o[keys[j]]);
      }
    }
  }
  collectContent(data);
  return parts.join("");
}
// 跨模块共享的可变状态。ESM 的 import 绑定只读，基本类型无法跨模块重赋值，
// 故把跨模块读写的全局集中到一个对象上（对象属性可自由变更，live binding 可见）。
// 模块私有的可变态（lsCache / ratioMap / detailTimer 等）仍留在各自模块内。
export const store = {
  pageLeaving: false, // 页面刷新/关闭标记：导航掐死的流不算"出错"，也不覆盖上条结果
  streamEpoch: 0, // 单调递增流纪元：同一会话停止→立即重发时丢弃旧流的一切事件/收尾
  activeLlm: null, // {ts, providerId, model}：/api/models/active 缓存
  providerMap: {}, // providerId -> base_url（渠道判定需要时才拉，缓存 24h）
  states: {} // 每会话一个 state（LRU 上限见 state.js）
};

// activeLlm 从 localStorage 恢复（原 05-channel 顶层逻辑）
try {
  const raw = JSON.parse(localStorage.getItem("qp_token_speed_active_llm") || "null");
  if (raw && typeof raw === "object") store.activeLlm = raw;
} catch (e) {
  /* ignore */
}

// 页面离开标记（原 01-core）
try {
  window.addEventListener("pagehide", function () {
    store.pageLeaving = true;
  });
  window.addEventListener("beforeunload", function () {
    store.pageLeaving = true;
  });
  window.addEventListener("pageshow", function () {
    store.pageLeaving = false;
  });
} catch (e) {
  /* 个别环境无 window 事件 */
}
// 生产入口：防重复注入守卫 → fetch 拦截最早生效 → 初始化。
// UI 模块以副作用导入填充 renderer 总线；引擎只依赖总线，不直接触碰 DOM。
import "./store.js";
import { patchFetch } from "./stream.js";
import { init } from "./init.js";
import "./ui-styles.js";
import "./ui-bar.js";
import "./ui-panel.js";
import "./ui-mount.js";

(function () {
  "use strict";
  // 防重复注入：插件被加载两次时避免双层 fetch patch → 每个事件统计两遍
  if (window.__qpTokenSpeedLoaded) return;
  window.__qpTokenSpeedLoaded = true;
  window.__qpTokenSpeedVersion = __QP_TS_VERSION__;

  // fetch 拦截要最早生效
  if (typeof window !== "undefined") patchFetch();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
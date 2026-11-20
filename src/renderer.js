// 渲染总线：引擎（turn / metrics / stream）经此调用 UI，不直接依赖 DOM。
// 默认 noop —— UI 模块加载后填入真实实现；UI 缺失或注入失败时引擎仍正常统计（优雅降级）。
// 测试可注入 noop / 探针，无需构造 DOM mock。这是引擎与展示层的依赖倒置边界。
// 签名以 JSDoc 声明契约（参数为动态视图对象，用 any 容忍 JS 的动态结构）。
export const renderer = {
  /** @param {any} _view 生成中视图（runningView） */
  renderRunning(_view) {},
  /** @param {any} _st 回放中的流状态 */
  renderReplay(_st) {},
  /** @param {any} _result 终态结果 */
  renderDone(_result) {},
  renderWaiting() {},
  /** @param {any} [_forceResult] 强制用这份结果重绘（省略则按签名增量刷新） */
  refreshDetail(_forceResult) {},
  refreshBarContent() {}
};
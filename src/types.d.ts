// 全局类型补充：生产入口守卫挂在 window 上的标记，以及 esbuild define 注入的版本常量。
// 仅用于 checkJs 类型检查，不参与运行时（.d.ts 不被打包）。
declare const __QP_TS_VERSION__: string;

interface Window {
  __qpTokenSpeedLoaded?: boolean;
  __qpTokenSpeedVersion?: string;
  testApi?: any;
}
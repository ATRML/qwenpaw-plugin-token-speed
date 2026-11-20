// 构建：esbuild 把 src/index.js（真实 ESM）打包成单文件 IIFE dist/index.js。
// QwenPaw 直接加载 dist/index.js；产物自包含、零运行时依赖。
// 用法：node scripts/build.mjs（或 npm run build / python build.py）。
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));

const banner = `/**
 * QwenPaw 插件：Token 实时速度 v${manifest.version}（前端核心，esbuild 打包）
 * 拦截聊天 SSE 流（POST /api/console/chat），统计 TTFT / 实时速度 / 本轮总量 / 分项耗时 /
 * 费用（套餐额度 / 人民币 / 阿里云百炼 Token Plan Credits）。悬浮条 + 详情面板，fixed 脱离 React 树。
 * 源码在 src/（ESM），请勿手改 dist/index.js。调价改 src/pricing-data.js。版本史见 CHANGELOG.md。
 * @license MIT
 */`;

const shared = {
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  define: { __QP_TS_VERSION__: JSON.stringify(manifest.version) },
  logLevel: "info"
};

// 生产产物：QwenPaw 直接加载，自包含、零运行时依赖、不暴露测试钩子。
await build({
  ...shared,
  entryPoints: [path.join(root, "src/index.js")],
  outfile: path.join(root, "dist/index.js"),
  banner: { js: banner }
});

// 测试产物：暴露 window.testApi 供无头回归驱动；不进发布包。
await build({
  ...shared,
  entryPoints: [path.join(root, "test/entry.js")],
  outfile: path.join(root, "dist/test-bundle.js"),
  logLevel: "warning"
});

// 生命周期测试产物：保留真实渲染总线 + DOM 挂载函数，供 DOM mock 驱动。
await build({
  ...shared,
  entryPoints: [path.join(root, "test/lifecycle-entry.js")],
  outfile: path.join(root, "dist/lifecycle-bundle.js"),
  logLevel: "warning"
});
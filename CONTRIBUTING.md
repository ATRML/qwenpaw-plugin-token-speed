# 贡献指南

感谢关注 TokenSpeed。这是一个 QwenPaw 纯前端插件，统计与计费逻辑对精度敏感，贡献时请遵守以下约定。

## 开发环境

```bash
npm install
npm run verify   # lint + typecheck + build + 语法校验 + 全部测试，必须全绿
```

要求 Node.js >= 18。开发期依赖（esbuild / eslint / prettier / typescript）只在本地使用，**不进入发布产物**。

## 提交前检查清单

- `npm run verify` 全绿（ESLint 零告警、checkJs 零类型错误、79 个测试场景通过）。
- 新增/修改行为必须配**行为断言**测试，不要写锁定精确文案的脆弱断言。
- 计价改动只改 `src/pricing-data.js`（纯数据），并在 PR 里附官方刊例价来源链接与对拍示例。
- 流式/分段/回合生命周期逻辑历经多轮修复，改动需说明动机并补回归场景，不要凭直觉重写。

## 架构约定

- 引擎模块（turn / metrics / stream / init）**不直接触碰 DOM**，一律经 `renderer.js` 渲染总线调用 UI。
- 跨模块可变态放 `store.js`，不要在模块间重赋值 ESM 导入绑定。
- 价目数据与计价引擎分离：数据在 `pricing-data.js`，逻辑在 `pricing.js`。
- 生产入口 `src/index.js` 不暴露测试钩子；测试暴露面只在 `test/entry.js` / `test/lifecycle-entry.js`。

## 计价数据来源

调价以阿里云百炼官方为准：

- <https://help.aliyun.com/zh/model-studio/token-plan-usage-quota>
- <https://help.aliyun.com/zh/model-studio/token-plan-personal-overview>
- <https://help.aliyun.com/zh/model-studio/model-pricing>

换算：`credits/万tok` 数值 = 刊例价 `元/百万tok`（1 credit = 0.01 元）。夜间折扣按北京时间 22:00–08:00，测试用显式 UTC 常量对拍。

## 隐私红线

- 不得提交个人路径、真实会话 ID、内部实测记录或任何遥测。
- 插件只写本机 `localStorage`，不发起上报请求；渠道识别只读 QwenPaw 自身接口。

## 发布

发布包只含 `plugin.json` / `plugin.py` / `dist/index.js`（及 README / LICENSE / CHANGELOG）。`dist/test-bundle.js`、`dist/lifecycle-bundle.js`、`node_modules/`、内部笔记不进发布包。
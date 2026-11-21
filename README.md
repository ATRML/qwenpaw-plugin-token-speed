# TokenSpeed —— QwenPaw 插件：Token 实时速度

在 QwenPaw 控制台聊天时，实时显示大模型的流式生成速度、本轮用量与计费。悬浮条贴在输入框上方，点击展开详情面板：分段速度折线图 + 分段明细 + 完整汇总。

纯前端实现：无后端路由、无运行时依赖、无需配置。所有统计与账本仅存于本机浏览器 `localStorage`，不上传任何数据。

## 功能特性

- **实时速度**：拦截聊天 SSE 流逐片计时，实时 tokens/s；区分"真流式解码"与"网关补发/中途接入回放"，避免峰值虚高。
- **首字延迟（TTFT）与分项耗时**：首字等待、工具/空闲等待、工具后模型等待、总耗时单列。
- **分段明细与折线图**：语义分段展示每段速度曲线，峰值与均值一目了然；生成中另有实时速度 sparkline 与燃烧率（credits/min、$/min 或 ¥/h）。
- **多 provider 通用计价**：内置 OpenAI / Anthropic / Google Gemini 美元刊例价（标准档，含长上下文输入阶梯），按 provider/端点自动识别渠道；美元、人民币、Credits、套餐额度四种货币分桶统计、互不混算。未识别渠道只报 token、不猜金额。
- **用量与计费**：本轮输出 tokens、费用估算，严格区分前端观测估算（带 ≈）与后端官方用量。
- **阿里云百炼 Token Plan**：credits 计价（`credits/万tok` 的数值 = 官方刊例价 `元/百万tok`，1 credit = 0.01 元刊例价），含输入 token 阶梯计价、北京 22–08 点官方夜间折扣、`qwen4-max-preview` 预览期折扣、auto 路由参考区间；Credits 三分量分解（输入/缓存/输出）+ 刊例价折算 + 按套餐档位摊销。
- **百炼按量付费 / DeepSeek 官方**：人民币刊例价计价，DeepSeek 系模型分忙/闲时（忙 08:00–22:00 北京）。
- **今日消耗账本**：本地滚动流水聚合今日回合/输出/美元/人民币/credits/额度与 Top3 模型，刷新恢复不重复计账。
- **会话切换恢复**：切换会话后可恢复当前轮统计；页面刷新后能识别"中途接入"的回合。
- **防御性统计口径**：工具调用参数计入输出、批量冲刷（flush）剔除、静默补发识别、过期纪元流主动 cancel。

## 安装

```bash
# 本地目录安装（开发调试）
qwenpaw plugin install <本目录>

# zip 包安装
qwenpaw plugin install token-speed.zip
```

要求 QwenPaw >= 2.0.0。发布包只需 `plugin.json` / `plugin.py` / `dist/index.js`。

## 架构

v2 起源码是**真实 ESM 模块**，由 esbuild 打包成单文件 IIFE，取代了早期"按序号拼接 16 个片段"的构建方式：

- **引擎与展示解耦**：`turn` / `metrics` / `stream` 等引擎模块只通过 `renderer.js` 渲染总线调用 UI，不直接触碰 DOM。UI 模块加载后把真实实现注入总线；UI 缺失或注入失败时引擎静默降级，统计不受影响。
- **数据与逻辑分离**：价目表是纯数据 `pricing-data.js`，计价引擎在 `pricing.js`。调价只改数据，不碰逻辑。
- **跨模块可变态集中**：`store.js` 收纳会话状态、流纪元、渠道缓存等可变态，避免 ESM 只读绑定带来的跨模块赋值问题。
- **函数体逐字保留**：历经多轮修复的精密流式逻辑在重构中原样保留，仅改 import/export 与总线引用，行为由回归套件锁定。

```
src/
├── index.js          # 生产入口：防重复注入守卫 → patchFetch → init
├── store.js          # 跨模块可变态（会话/流纪元/渠道缓存）
├── renderer.js       # 渲染总线（引擎 ↔ UI 的依赖倒置边界）
├── constants.js / session.js / utils.js / tokens.js
├── state.js / persistence.js / ledger.js / model.js / diagnostics.js
├── pricing-data.js   # 纯价目数据（PRICING / TP_PLANS / 覆盖层）
├── pricing.js        # 计价引擎（套餐/人民币/TokenPlan credits/按量）
├── channel.js        # 渠道识别（provider_id / base_url 证据）
├── turn.js / metrics.js / stream.js   # 回合生命周期 / 视图口径 / SSE 流解析
├── ui-styles.js / ui-bar.js / ui-panel.js / ui-mount.js   # 展示层
└── init.js           # 初始化与 1s 主循环
```

## 开发

```bash
npm install        # 安装 esbuild / eslint / prettier / typescript（仅开发期）
npm run build      # esbuild 打包 dist/index.js（+ 测试 bundle）
npm run lint       # ESLint
npm run typecheck  # tsc checkJs 类型检查
npm test           # 73 行为回归 + 13 生命周期专项
npm run verify     # lint + typecheck + build + 语法校验 + 全部测试
```

测试是无头 Node VM 驱动：`test/regression.cjs` 用最小上下文锁定计价/流式/稳定性行为，`test/lifecycle.cjs` 用 DOM mock 覆盖 init 主循环、路由切换、pagehide、双注入守卫、渲染降级、DOM 卫生与面板增量刷新。测试入口（`test/entry.js` / `test/lifecycle-entry.js`）单独打包，**不暴露任何测试钩子到生产 `dist/index.js`**。

## 计价来源

美元刊例价（标准档快照 2026-11-21，调价时以官方实时页为准，可经覆盖层修正）：

- OpenAI：<https://platform.openai.com/docs/pricing>
- Anthropic：<https://docs.anthropic.com/en/docs/about-claude/pricing>
- Google Gemini：<https://ai.google.dev/gemini-api/docs/pricing>

美元金额按 `((输入−缓存)×input + 缓存×cacheHit + 输出×output) / 1e6` 计算，长上下文模型按单次请求输入 token 选阶梯（如 gpt-5.4 >272K、Gemini Pro >200K）。只收录有把握的官方价；未入表模型不显示金额（不猜）。

阿里云百炼官方刊例价（调价时以官方为准）：

- Token Plan 用量与额度：<https://help.aliyun.com/zh/model-studio/token-plan-usage-quota>
- Token Plan 个人版概述：<https://help.aliyun.com/zh/model-studio/token-plan-personal-overview>
- 模型计费：<https://help.aliyun.com/zh/model-studio/model-pricing>

换算关系：`credits/万tok` 的数值等于刊例价 `元/百万tok`（1 credit = 0.01 元刊例价）。夜间折扣与阶梯计价按官方口径实现，测试用显式 UTC 时间常量对拍，与运行时时区无关。

## 自定义计价

任意第三方渠道（中转/私有网关）都能接全套计价，纯数据配置。把一份 JSON 写入 `localStorage["qp_token_speed_pricing"]` 后刷新即可生效：

```js
localStorage.setItem("qp_token_speed_pricing", JSON.stringify({
  // 1) provider 证据 → 渠道名（provider_id / base_url 命中子串即判入该渠道）
  customChannels: [{ keys: ["my-relay.example"], channel: "my-relay" }],
  // 2) 渠道名 → 价目条目（顺序即优先级，可混用按量/套餐/限时窗口）
  generic: { models: [
    { channel: "my-relay", keys: ["gpt-x"], table: { offPeak: { input: 10, output: 30 } } },
    { channel: "my-relay", keys: ["bundled-model"], coef: 2.5, unit: "plan" },
    { channel: "my-relay", keys: ["promo-model"], coef: 0.5, unit: "plan",
      start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) }
  ]},
  // 3) 内置套餐渠道补模型/调价
  plan: { base: [{ keys: ["my-private-model"], coef: 1.5 }] },
  // 4) 百炼 Token Plan 补模型（credits/万tok = 刊例价 元/百万tok；tiers 按输入 token 阶梯）
  tokenplan: { models: [
    { keys: ["my-qwen-fork"], tiers: [{ upTo: Infinity, input: 12, output: 36, cacheHit: 1.5 }], night: 0.4 }
  ]},
  // 5) 通用 USD 渠道补模型/调价（美元/百万tok；tiers 按输入 token 阶梯，cacheHit 缺省按输入价估）
  usd: { openai: { models: [
    { keys: ["my-gpt-fork"], tiers: [{ upTo: Infinity, input: 2, output: 8, cacheHit: 0.5 }] }
  ]}}
}));
```

- 未配置价表的渠道只报 token 不报金额（不猜数）；配置后详情面板自动显示费用/套餐抵扣。
- 覆盖层解析失败或结构不对时整份忽略（`console.warn`），内置价目原样生效，绝不崩面板。
- 删除该 `localStorage` 键即恢复内置价目。

## 隐私

- 统计、结果与今日账本只写本机浏览器 `localStorage`，插件不发起任何上报请求。
- 渠道识别仅读取 QwenPaw 自身的 `/api/models/active` 与 `/api/models`（用于判定计费渠道），不访问外部服务。
- 仓库不含任何个人路径、会话 ID 或内部实测记录。

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
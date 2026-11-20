# TokenSpeed —— QwenPaw 插件：Token 实时速度

在 QwenPaw 控制台聊天时，实时显示大模型的流式生成速度。悬浮条贴在输入框上方，点击展开详情面板：分段速度折线图 + 分段明细 + 完整汇总。

## 功能特性

- **实时速度**：拦截聊天 SSE 流逐片计时，实时 tokens/s；区分"真流式解码"与"网关补发/中途接入回放"，避免峰值虚高
- **首字延迟（TTFT）**：从请求发出到第一个 token 到达的耗时
- **分段明细与折线图**：语义分段展示每段速度曲线，峰值与均值一目了然；生成中另有实时速度 sparkline 与燃烧率（credits/min 或 ¥/h）
- **用量与计费**：本轮输出 tokens、分项耗时、费用估算（区分前端观测估算与后端官方用量），按内置价目表计算（套餐额度 / 人民币 / 百炼 Credits）
- **阿里云百炼 Token Plan**：credits 计价（credits/万tok 数值 = 官方刊例价 元/百万tok），含阶梯计价、北京 22–08 点官方夜间折扣、qwen4-max-preview 预览期折扣、auto 路由参考区间；Credits 三分量分解（输入/缓存/输出）+ 刊例价折算 + 按套餐档位摊销
- **今日消耗账本**：本地滚动流水聚合今日回合/输出/credits/人民币/额度与 Top3 模型，刷新恢复不重复计账
- **会话切换恢复**：切换会话后可恢复当前轮统计；页面刷新后能识别"中途接入"的回合
- **防御性统计口径**：工具调用参数计入 token、批量冲刷（flush）剔除、静默补发识别

## 安装

```bash
# 本地目录安装（开发调试）
qwenpaw plugin install <本目录>

# zip 包安装
qwenpaw plugin install token-speed.zip
```

要求 QwenPaw >= 2.0.0。纯前端实现：无后端路由、无 npm 依赖、无需配置。

## 构建

源码在 `src/`（16 个模块，按序号拼接），构建时合并为单文件 IIFE `dist/index.js`：

```bash
python build.py
```

依赖：Python 3（拼接）+ Node.js（仅用于生成后语法校验）。无打包器。

调整价目/系数只需改 `src/06-pricing.js` 顶部的 `PRICING` 静态数据区；不改源码也能在运行时覆盖（见下）。

## 自定义计价

任意第三方渠道（中转/私有网关）都能接全套计价，纯数据配置。把一份 JSON 写入 `localStorage["qp_token_speed_pricing"]` 后刷新即可生效：

```js
localStorage.setItem("qp_token_speed_pricing", JSON.stringify({
  // 1) provider 证据 → 渠道名（provider_id / base_url 命中子串即判入该渠道）
  customChannels: [{ keys: ["my-relay.com"], channel: "my-relay" }],
  // 2) 渠道名 → 价目条目（顺序即优先级，可混用按量/套餐/限时窗口）
  generic: { models: [
    // 按量（元/百万 token，可选 peak/peakHours/weekendOffPeak/cacheHit）
    { channel: "my-relay", keys: ["gpt-x"], table: { offPeak: { input: 10, output: 30 } } },
    // 套餐（额度 = (输入+输出)×系数/10000，unit:"plan" 让面板按"额度"显示）
    { channel: "my-relay", keys: ["bundled-model"], coef: 2.5, unit: "plan" },
    // 限时活动（UTC 毫秒窗口，过期自动跳过回退下一条）
    { channel: "my-relay", keys: ["promo-model"], coef: 0.5, unit: "plan",
      start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) }
  ]},
  // 3) 内置套餐渠道补模型/调价（plan.base/plan.promo 前置合并，旧键名 afp.* 也兼容）
  plan: { base: [{ keys: ["my-private-model"], coef: 1.5 }] },
  // 4) 百炼 Token Plan 补模型（credits/万tok = 刊例价 元/百万tok；tiers 按输入 token 阶梯，
  //    night=北京22–08折扣系数，preview=限时窗口，前置合并优先命中）
  tokenplan: { models: [
    { keys: ["my-qwen-fork"], tiers: [{ upTo: Infinity, input: 12, output: 36, cacheHit: 1.5 }], night: 0.4 }
  ]}
}));
```

- 未配置价表的渠道只报 token 不报金额（不猜数）；配置了价目后详情面板自动显示"费用/套餐抵扣"。
- 覆盖层解析失败或结构不对时整份忽略（console.warn），内置价目原样生效，绝不崩面板。
- 删除该 localStorage 键即恢复内置价目。

## 目录结构

```
├── plugin.json        # QwenPaw 插件清单
├── plugin.py          # 最小后端桩（满足安装校验，无路由）
├── build.py           # 构建脚本：src/*.js → dist/index.js
├── src/               # 16 个前端模块（核心/状态/工具/token 口径/渠道/计价/流解析/UI/诊断/初始化）
└── dist/index.js      # 构建产物（前端入口）
```

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE)

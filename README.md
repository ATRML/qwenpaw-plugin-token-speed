# TokenSpeed —— QwenPaw 插件：Token 实时速度

在 QwenPaw 控制台聊天时，实时显示大模型的流式生成速度。悬浮条贴在输入框上方，点击展开详情面板：分段速度折线图 + 分段明细 + 完整汇总。

## 功能特性

- **实时速度**：拦截聊天 SSE 流逐片计时，实时 tokens/s；区分"真流式解码"与"网关补发/中途接入回放"，避免峰值虚高
- **首字延迟（TTFT）**：从请求发出到第一个 token 到达的耗时
- **分段明细与折线图**：语义分段展示每段速度曲线，峰值与均值一目了然
- **用量与计费**：本轮输出 tokens、分项耗时、费用估算（区分前端观测估算与后端官方用量），按内置价目表计算（AFP / 人民币）
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

调整价目/系数只需改 `src/06-pricing.js` 顶部的 `PRICING` 静态数据区。

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

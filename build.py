# -*- coding: utf-8 -*-
"""构建：把 src/*.js 按序拼接成 dist/index.js（单文件 IIFE，无打包器依赖）。
用法：python build.py
"""
import glob, io, json, os, shutil, subprocess, time

ROOT = os.path.dirname(os.path.abspath(__file__))

HEADER = """/**
 * QwenPaw 插件：Token 实时速度（前端核心）
 * - 拦截聊天 SSE 流（POST /api/console/chat，响应为 text/event-stream）
 * - 统计：首字延迟 TTFT、实时 token 速度、本轮 token 总量、耗时、工具等待、费用（套餐额度/人民币）
 * - 显示为固定悬浮条（输入框上方），不进入 React 管理树；点击悬浮条展开详情面板
 *   （大号分段速度折线图 + 分段明细 + 完整汇总）
 *
 * 本文件由 build.py 从 src/*.js 拼接生成，请勿直接手改 dist/index.js。
 * 调价只改 src/06-pricing.js 顶部的 PRICING 静态数据区。
 * 版本史见 CHANGELOG.md。
 */
"""

PRELUDE = """(function () {
  "use strict";

  // 防重复注入：插件被加载两次时避免双层 fetch patch → 每个事件统计两遍
  if (window.__qpTokenSpeedLoaded) return;
  window.__qpTokenSpeedLoaded = true;

"""

FOOTER = """
  // fetch 拦截要最早生效
  if (typeof window !== "undefined") {
    patchFetch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
"""

def main():
    manifest = json.loads(open(os.path.join(ROOT, "plugin.json"), encoding="utf-8").read())
    parts = [HEADER, PRELUDE, "  window.__qpTokenSpeedVersion = " + json.dumps(manifest['version']) + ";\n\n"]
    paths = sorted(glob.glob(os.path.join(ROOT, "src", "*.js")))
    if len(paths) != 16:
        raise SystemExit("Expected all 16 source modules; refusing an incomplete build")
    for path in paths:
        with io.open(path, encoding="utf-8") as f:
            parts.append(f.read().rstrip("\n") + "\n\n")
    parts.append(FOOTER)
    out = "".join(parts)
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    target = os.path.join(ROOT, "dist", "index.js")
    temporary = target + ".building.js"
    with io.open(temporary, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required to validate the generated JavaScript")
    subprocess.run([node, "--check", temporary], check=True)
    for attempt in range(6):
        try:
            os.replace(temporary, target)
            break
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.1 * (attempt + 1))
    print("built %s (%d bytes, %d lines)" % (target, len(out.encode("utf-8")), out.count("\n") + 1))

if __name__ == "__main__":
    main()

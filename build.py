# -*- coding: utf-8 -*-
"""构建入口（兼容旧命令）：委托 esbuild 打包。

真实构建逻辑在 scripts/build.mjs —— 把 src/index.js（真实 ESM）打包成单文件 IIFE
dist/index.js，自包含、零运行时依赖。另产出 dist/test-bundle.js 与 dist/lifecycle-bundle.js
供无头回归驱动（不进发布包）。

用法：python build.py  /  npm run build  /  node scripts/build.mjs
依赖：Node.js >= 18 + npm install（esbuild）。
"""
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))


def main():
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js >= 18 is required for the esbuild build.")
    if not os.path.isdir(os.path.join(ROOT, "node_modules", "esbuild")):
        npm = shutil.which("npm")
        if not npm:
            raise SystemExit("npm not found; run `npm install` first.")
        subprocess.run([npm, "install"], cwd=ROOT, check=True)
    subprocess.run([node, os.path.join(ROOT, "scripts", "build.mjs")], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
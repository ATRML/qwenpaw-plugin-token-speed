import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, __QP_TS_VERSION__: "readonly" }
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-prototype-builtins": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-cond-assign": ["error", "except-parens"]
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }] }
  },
  {
    files: ["test/**/*.cjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }] }
  },
  {
    // 测试入口（ESM，浏览器上下文）：暴露 window.testApi，不自动跑 init/patchFetch
    files: ["test/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.browser } },
    rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }] }
  }
];
// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // import/no-unresolved 解析器显式给 TS/RN 扩展名（react-native-svg 的
    // main 指向 lib/commonjs/index.js，默认解析在某些插件版本下会漏报已安装的包）
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
        },
      },
    },
  },
  {
    ignores: ["dist/*"],
  },
  // 阶段 0 基线护栏 → 阶段 1 收口：禁止组件层直接调用 fetch。
  //
  // 演进过程：
  //   阶段 0 设为 warn —— 旧壳 App.tsx + components/ 当时有 17 处历史调用，
  //   设为 error 会立即产生 17 个错误、阻塞回归；warn 只做基线护栏。
  //   阶段 1 已把这 17 处全部收口到 lib/api/client（PR #24），组件层不再
  //   直接 fetch，因此本规则提升为 error：新代码一旦绕过网络层就立即失败。
  //
  // 范围：只约束组件层（app/** + components/**）；lib/ 属于网络层，
  //   由 lib/api/client 承担，不在此规则范围内。
  //
  // 2026-11-19 旧壳删除：原 App.tsx 模式替换为 v7 壳目录 app/**
  // （expo lint 默认扫描 /app 与 /components，app/** 在默认范围内即生效；
  //   当前 app/ 内没有直接 fetch 调用，规则为预防性护栏）。
  {
    files: ['app/**/*.{js,jsx,ts,tsx}', 'components/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            '禁止在组件层直接调用 fetch；请改用 lib/api/client（阶段 1 网络层收口）。',
        },
        {
          selector:
            "CallExpression[callee.object.name='globalThis'][callee.property.name='fetch']",
          message:
            '禁止在组件层直接调用 fetch；请改用 lib/api/client（阶段 1 网络层收口）。',
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name='fetch']",
          message:
            '禁止在组件层直接调用 fetch；请改用 lib/api/client（阶段 1 网络层收口）。',
        },
      ],
    },
  },
]);

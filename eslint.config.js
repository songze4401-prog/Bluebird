// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  // 阶段 0 基线护栏 → 阶段 1 收口：禁止组件层直接调用 fetch。
  //
  // 演进过程：
  //   阶段 0 设为 warn —— App.tsx + components/ 当时有 17 处历史调用，
  //   设为 error 会立即产生 17 个错误、阻塞回归；warn 只做基线护栏。
  //   阶段 1 已把这 17 处全部收口到 lib/api/client（PR #24），组件层不再
  //   直接 fetch，因此本规则提升为 error：新代码一旦绕过网络层就立即失败。
  //
  // 范围：只约束组件层（App.tsx + components/**）；lib/ 属于网络层，
  //   由 lib/api/client 承担，不在此规则范围内。
  //
  // 注意（实测边界）：expo lint 默认只扫 /src、/app、/components 三个目录，
  //   根目录 App.tsx 不在默认范围；需显式 `expo lint App.tsx components`
  //   才会检查。因此默认回归中本规则只对 components/ 立即生效；App.tsx 的
  //   规则已在此配好，待其纳入 lint 范围后会自然激活。
  {
    files: ['App.tsx', 'components/**/*.{js,jsx,ts,tsx}'],
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

// 蓝鸟 v7 新壳预览开关（旧壳仍是生产默认）。
// 由 EXPO_PUBLIC_UI_V7 驱动：仓库默认不设置该变量 ⇒ false（CI/旧壳测试按旧壳跑）。
// 本地预览只在 .env 里写 EXPO_PUBLIC_UI_V7=1（.env 不入库），不再需要改源码，
// 也就不会因为切分支 / 跑旧壳门禁 / git checkout 把开关翻回去。
export const UI_V7_PREVIEW = process.env.EXPO_PUBLIC_UI_V7 === '1';

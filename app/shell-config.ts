// 蓝鸟 v7 新壳预览开关（旧壳仍是生产默认）。
// 本仓库是 CI/提交源：此值必须保持 false——预览请用 Trae 副本（那边才是翻 true 的地方）。
// 原因：app-smoke 等 legacy 测试按这个开关选择被测壳，工作树里翻 true 会让旧壳测试全灭。
export const UI_V7_PREVIEW = false;

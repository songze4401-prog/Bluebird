// 聊天页的布局刻度：集中在这里，组件不写散落的魔数。
//
// 2026-10-30 对话页改为「暖白画布 + 白色卡片」：
//   - 顶栏按钮改为 38dp 圆形卡片，顶栏高度同步加到 56dp；
//   - 输入区从单行胶囊改为带输入行和控件行的大圆角卡片；
//   - 消息流的 turnGap / sameGap / 气泡内距沿用上一版节奏，不因换肤改阅读密度。
//
// 组件只引用这里的常量，改设计时只需要改这一处。

export const CHAT_LAYOUT = {
  /** 顶部栏高度：容纳 38dp 圆形按钮并保留上下呼吸 */
  topBarHeight: 56,
  /** 聊天页与底部 dock 的左右内边距 */
  gutter: 20,
  /** 消息流顶部留白 */
  threadTopPad: 16,
  /** 换轮次之间的空档 */
  turnGap: 48,
  /** 同一轮助手续接之间的空档 */
  sameGap: 20,
  /** 时间戳 → 正文 */
  tsToText: 12,
  /** who-line（Bluebird + 表情 + 时间）→ 正文 */
  nameToText: 10,
  /** 正文 → 该条的操作行 */
  textToActions: 16,

  /** 工具调用 pill 高度 */
  toolPillHeight: 32,
  /** 模型选择 pill 高度（输入卡片内） */
  modelPillHeight: 36,
  /** 输入卡片内的圆形控件直径 */
  controlSize: 38,
  /** 输入卡片圆角 */
  composerRadius: 28,
  /** 输入卡片最小高度（输入行 + 控件行 + 内边距） */
  composerMinHeight: 112,
  /** 输入卡片内边距 */
  composerPadding: 12,

  /** 标签栏内容高（不含底部安全区） */
  tabBarHeight: 46,
  /** 标签图标边长 */
  tabIconSize: 20,
  /** 标签图标 → 文字 */
  tabIconGap: 4,
} as const;

export const CHAT_TYPE = {
  /** 顶部品牌名 */
  title: 16,
  /** 消息正文 */
  body: 16,
  bodyLine: 26,
  /** 助手消息的「Bluebird」名字 */
  name: 12,
  /** 时间戳 */
  meta: 11,
  /** 工具 pill / 模型 pill 内文字 */
  pill: 11,
  /** 标签栏文字 */
  tabLabel: 11,
} as const;

// 聊天页的布局刻度：全部从设计图实测换算，不散落在各组件里写魔数。
//
// 换算依据（可复现）：设计图截图 1080×2376，其中手机卡片占 x 65..1075
// 共 1011px，对应设计稿 380 CSS px 宽 → 缩放系数 2.66 px/dp。
// 例：输入胶囊实测高 134px → 50dp；左右内边距实测 52px → 20dp。
//
// 组件只引用这里的常量，改设计稿时只需要改这一处。

export const CHAT_LAYOUT = {
  /** 顶部栏高度（实测：☰/Bluebird 字形带 y 716..755，上下各留约 16dp） */
  topBarHeight: 48,
  /** 聊天页与底部 dock 的左右内边距（实测 52px） */
  gutter: 20,
  /** 消息流顶部留白（实测：顶栏字形带底 755 → 首个时间戳 840，共 85px） */
  threadTopPad: 16,
  /** 换轮次之间的空档（实测 141px：上一条正文 → 下一条时间戳） */
  turnGap: 48,
  /** 同一轮助手续接之间的空档（实测 55px，设计图 .msg.same） */
  sameGap: 20,
  /** 时间戳 → 正文（实测 35px） */
  tsToText: 12,
  /** who-line（Bluebird + 表情 + 时间）→ 正文（实测 27px） */
  nameToText: 10,
  /** 正文 → 该条的操作行（实测 43px） */
  textToActions: 16,

  /** 工具调用 pill 高度（实测 83px） */
  toolPillHeight: 32,
  /** 模型选择 pill 高度（实测 69px） */
  modelPillHeight: 26,
  /** 模型 pill → 输入胶囊（实测 27px） */
  modelPillGap: 10,
  /** 输入胶囊高度（实测 134px） */
  capsuleHeight: 50,
  /** 胶囊内的圆形控件直径：发送按钮（实测 90px） */
  controlSize: 34,
  /** 胶囊左右两端到圆形控件的间距（实测 (50-34)/2 = 8） */
  capsuleInset: 8,

  /** 标签栏内容高（不含底部安全区；实测 166px 总高减去 16dp 底部留白） */
  tabBarHeight: 46,
  /** 标签图标边长（实测 53px） */
  tabIconSize: 20,
  /** 标签图标 → 文字（实测 9px） */
  tabIconGap: 4,
} as const;

export const CHAT_TYPE = {
  /** 顶部品牌名 */
  title: 20,
  /** 消息正文 */
  body: 16,
  bodyLine: 24,
  /** 助手消息的「Bluebird」名字 */
  name: 15,
  /** 时间戳 */
  meta: 12,
  /** 工具 pill / 模型 pill 内文字 */
  pill: 13,
  /** 标签栏文字 */
  tabLabel: 11,
} as const;

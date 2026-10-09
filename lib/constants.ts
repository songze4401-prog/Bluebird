// 跨模块共享的常量（纯数据，不含逻辑）

export const API_TOKEN = process.env.EXPO_PUBLIC_BLUEBIRD_API_TOKEN;

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 与 Emotion System V1 的 8 种情绪一一对应（全项目只有这一套情绪值域）
export const MOOD_EMOJI: Record<string, string> = {
  calm: '😌',
  happy: '😊',
  playful: '😏',
  excited: '🤩',
  tired: '😴',
  sad: '😔',
  annoyed: '😒',
  hurt: '🥺',
};

// 微信式时间显示：间隔超过 5 分钟或跨天才显示一次时间标签
export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

// 距底部小于该距离视为"已在底部"：
// 决定「新消息是否自动跟随」以及「返回底部按钮是否显示」，两者互补不留死区
export const AT_BOTTOM_DISTANCE = 80;

// 跨模块共享的常量（纯数据，不含逻辑）

export const API_TOKEN = process.env.EXPO_PUBLIC_BLUEBIRD_API_TOKEN;

// 默认会话 id：与后端 sessions.js 的 DEFAULT_SESSION_ID 对齐。
// 全前端只在此处写死；未传 sessionId 时后端也会落到该会话（旧客户端兼容）。
export const DEFAULT_SESSION_ID = 'default';

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

// 情绪的中文名：点击顶部表情时的小气泡用它解释表情含义
export const MOOD_LABEL: Record<string, string> = {
  calm: '平静',
  happy: '开心',
  playful: '调皮',
  excited: '兴奋',
  tired: '疲惫',
  sad: '难过',
  annoyed: '烦躁',
  hurt: '委屈',
};

// 微信式时间显示：间隔超过 5 分钟或跨天才显示一次时间标签
export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

// 距底部小于该距离 → 显示「返回底部」箭头。
// 注意：它只决定箭头显不显示，不再参与「是否自动跟随」的判定（见下面 20）。
export const AT_BOTTOM_DISTANCE = 80;

// 距底部不超过该距离 → 拖拽/惯性结束时才允许把锁定态恢复为自动跟随。
// 刻意比 AT_BOTTOM_DISTANCE 更严格：80 只做视觉提示，20 才做状态机解除，
// 否则「刚滑开一点就被判定回底」会让锁定形同虚设。
export const FOLLOW_RESUME_DISTANCE = 20;

// 连续消息逐条展示的节奏：第一条立即出现，后续按上一条长度计算等待，
// 短消息短等待，长消息最多等 maxMs，避免无意义地吊着用户
export const REPLY_PACING = {
  baseMs: 280,
  perCharMs: 45,
  maxMs: 1600,
};
